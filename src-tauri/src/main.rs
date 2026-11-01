// Punchlist Manager - portable offline app.
// The Rust side is intentionally small: it owns the SQLite database file
// (stored in a "PunchlistData" folder next to the .exe), and provides a few
// helpers (Excel export, backup, opening links). All screens live in ../ui.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

/// Prefer a folder next to the .exe (portable). If that folder is not
/// writable (e.g. the exe was copied into Program Files), fall back to AppData.
fn pick_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("PunchlistData");
            if std::fs::create_dir_all(&candidate).is_ok() {
                let probe = candidate.join(".write_test");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return candidate;
                }
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let fallback = base.join("PunchlistManager");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn db_query(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let conn = state.conn.lock().map_err(err)?;
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let cols: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();
    let p: Vec<SqlValue> = params.iter().map(to_sql).collect();
    let mut rows = stmt.query(params_from_iter(p.iter())).map_err(err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut m = Map::new();
        for (i, c) in cols.iter().enumerate() {
            let v = match row.get_ref(i).map_err(err)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            m.insert(c.clone(), v);
        }
        out.push(m);
    }
    Ok(out)
}

#[tauri::command]
fn db_execute(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Value, String> {
    let conn = state.conn.lock().map_err(err)?;
    let p: Vec<SqlValue> = params.iter().map(to_sql).collect();
    let changes = conn.execute(&sql, params_from_iter(p.iter())).map_err(err)?;
    Ok(json!({ "changes": changes, "lastId": conn.last_insert_rowid() }))
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Value {
    json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "dbPath": state.data_dir.join("punchlist.db").to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Writes a clean copy of the database into PunchlistData/backups/<file_name>.
#[tauri::command]
fn backup_db(state: State<'_, AppState>, file_name: String) -> Result<String, String> {
    let safe: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() {
        return Err("Invalid backup name".into());
    }
    let dir = state.data_dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(safe);
    let path_str = path.to_string_lossy().into_owned();
    let conn = state.conn.lock().map_err(err)?;
    conn.execute("VACUUM INTO ?1", [&path_str]).map_err(err)?;
    Ok(path_str)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    open::that(url).map_err(err)
}

#[tauri::command]
fn open_data_folder(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.data_dir).map_err(err)
}

/// Asks where to save, then writes a simple one-sheet Excel file.
#[tauri::command]
async fn export_xlsx(
    default_name: String,
    sheet_name: String,
    headers: Vec<String>,
    rows: Vec<Vec<Value>>,
) -> Result<Option<String>, String> {
    let path = match rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Excel Workbook", &["xlsx"])
        .save_file()
    {
        Some(p) => p,
        None => return Ok(None),
    };

    let mut wb = Workbook::new();
    let header_fmt = Format::new().set_bold().set_background_color(Color::RGB(0xDCE6F1));
    let ws = wb.add_worksheet();
    let safe: String = sheet_name
        .chars()
        .filter(|c| !"[]:*?/\\".contains(*c))
        .take(31)
        .collect();
    if !safe.is_empty() {
        ws.set_name(&safe).map_err(err)?;
    }
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &header_fmt)
            .map_err(err)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let rr = (r + 1) as u32;
        for (c, v) in row.iter().enumerate() {
            let cc = c as u16;
            match v {
                Value::Null => {}
                Value::Number(n) => {
                    ws.write_number(rr, cc, n.as_f64().unwrap_or(0.0)).map_err(err)?;
                }
                Value::Bool(b) => {
                    ws.write_boolean(rr, cc, *b).map_err(err)?;
                }
                Value::String(s) => {
                    ws.write_string(rr, cc, s).map_err(err)?;
                }
                other => {
                    ws.write_string(rr, cc, other.to_string()).map_err(err)?;
                }
            }
        }
    }
    ws.autofit();
    wb.save(&path).map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn fatal(msg: &str) -> ! {
    rfd::MessageDialog::new()
        .set_title("Punchlist Manager")
        .set_description(msg)
        .set_level(rfd::MessageLevel::Error)
        .show();
    std::process::exit(1);
}

fn main() {
    let data_dir = pick_data_dir();
    let db_path = data_dir.join("punchlist.db");
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => fatal(&format!("Could not open the database at {}:\n{}", db_path.display(), e)),
    };
    if let Err(e) = conn.execute_batch(include_str!("schema.sql")) {
        fatal(&format!("Could not prepare the database:\n{}", e));
    }

    tauri::Builder::default()
        .manage(AppState {
            conn: Mutex::new(conn),
            data_dir,
        })
        .invoke_handler(tauri::generate_handler![
            db_query,
            db_execute,
            app_info,
            backup_db,
            open_url,
            open_data_folder,
            export_xlsx
        ])
        .run(tauri::generate_context!())
        .expect("error while running Punchlist Manager");
}
