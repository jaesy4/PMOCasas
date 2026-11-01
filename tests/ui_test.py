"""End-to-end click-through of the UI against mock_server.py."""
import json, subprocess, sys, time, os, urllib.request, datetime
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}/"
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)

srv = subprocess.Popen([sys.executable, os.path.join(HERE, "mock_server.py"), str(PORT)])
time.sleep(1.0)
errors = []
today = datetime.date.today()
iso = lambda d: d.isoformat()


def calls():
    return json.loads(urllib.request.urlopen(BASE + "calls").read())


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        errors.append(msg)


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1366, "height": 860})
        pg.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.goto(BASE)
        pg.wait_for_selector("h1:has-text('Dashboard')")
        pg.screenshot(path=f"{SHOTS}/01_dashboard_empty.png")

        # --- settings
        pg.click("#nav button[data-view=settings]")
        pg.fill("input[name=company_name]", "Sunrise Homes Inc.")
        pg.fill("input[name=company_address]", "Quezon City · 0917 000 0000")
        pg.click("#settings-form button[type=submit]")
        pg.wait_for_selector(".toast:has-text('Settings saved')")
        check(pg.inner_text("#brand-company") == "Sunrise Homes Inc.", "company name saved")

        # --- add two homeowners
        for name, unit, phone in [("Maria Santos", "Blk 5 Lot 12", "0917 123 4567"), ("Jose Reyes", "Blk 2 Lot 3", "0918 555 1111")]:
            pg.click("#nav button[data-view=homeowners]")
            pg.click("button:has-text('+ Add Homeowner')")
            pg.fill(".modal input[name=name]", name)
            pg.fill(".modal input[name=unit]", unit)
            pg.fill(".modal input[name=project]", "Phase 1")
            pg.fill(".modal input[name=phone]", phone)
            pg.click(".modal button[type=submit]")
            pg.wait_for_selector(f"h1:has-text('{name}')")
        check(True, "homeowners added")

        # --- schedule punchlist inspection for Maria tomorrow 09:00
        pg.click("#nav button[data-view=homeowners]")
        pg.fill("#ho-search", "maria")
        pg.wait_for_timeout(200)
        check(pg.locator("#ho-table tbody tr").count() == 1, "search filters homeowners")
        pg.click("#ho-table a:has-text('Maria Santos')")
        pg.click("button:has-text('+ Schedule')")
        pg.fill(".modal input[name=date]", iso(today + datetime.timedelta(days=1)))
        pg.fill(".modal input[name=start_time]", "09:00")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector(".modal-head:has-text('Google Calendar')")
        pg.click(".modal button[type=submit]")  # Add to Google Calendar
        pg.wait_for_selector(".modal-head:has-text('Add to Google Calendar')")
        url = [c for c in calls() if c["cmd"] == "open_url"][-1]["args"]["url"]
        print("   gcal url:", url[:200], "...")
        check("calendar.google.com/calendar/render?action=TEMPLATE" in url, "google calendar url opened")
        d1 = (today + datetime.timedelta(days=1)).strftime("%Y%m%d")
        check(f"dates={d1}T090000%2F{d1}T100000" in url, "gcal url has correct start/end")
        check("ctz=Asia%2FManila" in url, "gcal url has timezone")
        pg.click(".modal button[type=submit]")  # yes, mark as added
        pg.wait_for_selector("text=✓ In Google")
        check(True, "schedule marked in Google")

        # --- conflict: Jose same time tomorrow
        pg.click("#nav button[data-view=schedules]")
        pg.click("button:has-text('+ Add Schedule')")
        pg.select_option(".modal select[name=homeowner_id]", label="Jose Reyes – Blk 2 Lot 3")
        pg.fill(".modal input[name=date]", iso(today + datetime.timedelta(days=1)))
        pg.fill(".modal input[name=start_time]", "09:30")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector(".modal:has-text('Time conflict')")
        check(True, "double-booking warning shown")
        pg.screenshot(path=f"{SHOTS}/02_conflict_warning.png")
        pg.click(".modal-back:last-child button[type=submit]")  # save anyway
        pg.wait_for_selector(".modal-head:has-text('Google Calendar')")
        pg.click(".modal button[data-cancel]")  # later

        # --- record punchlist for Maria, repairs with target in the past (overdue)
        pg.click("#nav button[data-view=punchlist]")
        pg.click("button:has-text('+ Record Punchlist')")
        pg.select_option(".modal select[name=homeowner_id]", label="Maria Santos – Blk 5 Lot 12")
        rows = pg.locator("#punch-rows tr")
        items = [("Kitchen", "Cracked tile near sink", "Tiles / Flooring", "Major"),
                 ("Master Bedroom", "Door does not close fully", "Doors & Windows", "Minor"),
                 ("Toilet & Bath", "Leaking faucet", "Plumbing", "Major")]
        for i, (a, dfc, cat, sev) in enumerate(items):
            rows.nth(i).locator("input[name='area[]']").fill(a)
            rows.nth(i).locator("input[name='defect[]']").fill(dfc)
            rows.nth(i).locator("select[name='category[]']").select_option(cat)
            rows.nth(i).locator("select[name='severity[]']").select_option(sev)
        pg.click("#add-row")
        check(pg.locator("#punch-rows tr").count() == 6, "add row works")
        pg.fill(".modal input[name=assigned_to]", "Juan (Carpentry Team)")
        pg.fill(".modal input[name=target_date]", iso(today - datetime.timedelta(days=3)))
        pg.screenshot(path=f"{SHOTS}/03_record_punchlist.png")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector("h1:has-text('Maria Santos')")
        check(pg.locator(".flag:has-text('OVERDUE')").count() >= 3, "overdue flags on homeowner page")
        pg.screenshot(path=f"{SHOTS}/04_homeowner_detail.png", full_page=True)

        # --- acceptance with open items -> warning
        pg.click("button:has-text('+ Schedule')")
        pg.select_option(".modal select[name=kind]", "Acceptance")
        pg.fill(".modal input[name=date]", iso(today + datetime.timedelta(days=10)))
        pg.fill(".modal input[name=start_time]", "14:00")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector(".modal:has-text('3 open punchlist / repair items')")
        check(True, "acceptance warning with open items")
        pg.screenshot(path=f"{SHOTS}/05_acceptance_warning.png")
        pg.click(".modal-back:last-child button[type=submit]")
        pg.wait_for_selector(".modal-head:has-text('Google Calendar')")
        pg.click(".modal button[data-cancel]")
        check(pg.locator(".banner.red:has-text('Acceptance is set')").count() == 1, "acceptance banner on homeowner page")

        # --- repairs view
        pg.click("#nav button[data-view=repairs]")
        check(pg.locator("tr.overdue").count() == 3, "3 overdue rows red")
        check(pg.inner_text("#nav-overdue") == "3", "nav badge shows 3")
        pg.screenshot(path=f"{SHOTS}/06_repairs.png")
        pg.locator("button[data-act=repDone]").first.click()
        pg.wait_for_selector(".toast:has-text('marked as done')")
        pg.wait_for_timeout(200)
        check(pg.locator("tr.overdue").count() == 2, "mark done removes from overdue")
        fixed = json.loads(urllib.request.urlopen(BASE + "calls").read())
        # punch item fixed?
        pg.click("#nav button[data-view=punchlist]")
        pg.select_option("#punch-status", "Fixed")
        pg.wait_for_timeout(200)
        check(pg.locator("table.list tbody tr").count() == 1, "linked punch item marked Fixed")

        # --- edit repair: push target into future -> no longer overdue
        pg.click("#nav button[data-view=repairs]")
        pg.locator("button[data-act=editRep]").first.click()
        pg.fill(".modal input[name=target_date]", iso(today + datetime.timedelta(days=5)))
        pg.select_option(".modal select[name=status]", "In Progress")
        pg.click(".modal button[type=submit]")
        pg.wait_for_timeout(300)
        check(pg.locator("tr.overdue").count() == 1, "editing target date clears flag")

        # --- dashboard
        pg.click("#nav button[data-view=dashboard]")
        pg.wait_for_selector(".stat")
        pg.screenshot(path=f"{SHOTS}/07_dashboard.png", full_page=True)
        check(pg.locator(".banner.red:has-text('Acceptance for')").count() == 1, "dashboard acceptance alert")

        # --- printing
        pg.click("#nav button[data-view=reports]")
        pg.select_option("#r-ho1", label="Maria Santos – Blk 5 Lot 12")
        pg.click("button[data-act=printPunchForm]")
        pg.wait_for_function("window.__printed && window.__printed.length > 0")
        html = pg.evaluate("window.__printed")
        check("Cracked tile near sink" in html and "Sunrise Homes Inc." in html, "punchlist form prints")
        for act, extra, fname in [("printPunchForm", "#r-ho1", "punch"), ("printRepairs", None, "repairs"),
                                  ("printAcceptance", None, "acceptance"), ("printBlank", None, "blank"), ("printSchedules", None, "sched")]:
            pg.evaluate("window.__printed = null")
            # render to a page for screenshot
            sel = f".card button[data-act={act}]"
            pg.locator(sel).first.click()
            pg.wait_for_function("window.__printed")
            out = pg.evaluate("window.__printed")
            p2 = b.new_page(viewport={"width": 800, "height": 1100})
            p2.goto(BASE + "styles.css")
            p2.set_content(f"<html><head><link rel=stylesheet href='{BASE}styles.css'><style>body{{padding:30px;background:#fff}}</style></head><body>{out}</body></html>")
            p2.wait_for_timeout(200)
            p2.screenshot(path=f"{SHOTS}/print_{fname}.png", full_page=True)
            p2.close()
            check(len(out) > 200, f"{act} produced a document")

        # print to real PDF using Chromium's print CSS to check page layout
        pg.evaluate("window.__printed = null")
        pg.locator(".card button[data-act=printAcceptance]").click()
        pg.wait_for_function("window.__printed")
        pg.evaluate("document.getElementById('print-area').innerHTML = '<div class=doc>' + window.__printed + '</div>'")
        pg.emulate_media(media="print")
        pg.pdf(path=f"{SHOTS}/acceptance.pdf", format="A4")
        pg.emulate_media(media="screen")
        pg.evaluate("document.getElementById('print-area').innerHTML = ''")

        # --- exports
        for act in ["exportHo", "exportSched", "exportPunch", "exportRep"]:
            pg.locator(f".card button[data-act={act}]").click()
            pg.wait_for_timeout(250)
        ex = [c for c in calls() if c["cmd"] == "export_xlsx"]
        check(len(ex) == 4, "4 excel exports called")
        rep = [c for c in ex if c["args"]["sheetName"] == "Repairs"][0]["args"]
        check(rep["rows"][0][0] == "OVERDUE", "repairs export flags overdue first")
        check(all(len(r) == len(c["args"]["headers"]) for c in ex for r in c["args"]["rows"]), "export rows match headers")

        # --- reschedule a gcal-added schedule -> reminder
        pg.click("#nav button[data-view=schedules]")
        pg.locator("tr:has-text('✓ In Google') button[data-act=editSched]").first.click()
        pg.fill(".modal input[name=start_time]", "11:00")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector(".modal-head:has-text('Update Google Calendar')")
        check(True, "reschedule reminder shown")
        pg.click(".modal button[data-cancel]")
        pg.wait_for_timeout(200)
        check(pg.locator("text=✓ In Google").count() == 0, "gcal flag reset after reschedule")

        # --- backup + delete homeowner cascade
        pg.click("#nav button[data-view=settings]")
        pg.click("button[data-act=backup]")
        pg.wait_for_selector(".toast:has-text('Backup saved')")
        pg.click("#nav button[data-view=homeowners]")
        pg.fill("#ho-search", "")
        pg.wait_for_timeout(200)
        pg.click("#ho-table a:has-text('Jose Reyes')")
        pg.click("button[data-act=delHo]")
        pg.click(".modal button[type=submit]")
        pg.wait_for_selector("h1:has-text('Homeowners')")
        pg.wait_for_timeout(200)
        check(pg.locator("#ho-table tbody tr").count() == 1, "delete homeowner")
        pg.click("#nav button[data-view=schedules]")
        pg.select_option("#sched-filter", "all")
        pg.wait_for_timeout(200)
        check(pg.locator("table.list tbody tr:has-text('Jose')").count() == 0, "cascade deletes schedules")
        pg.screenshot(path=f"{SHOTS}/08_schedules.png")
        b.close()
finally:
    srv.terminate()

print("\nERRORS:" if errors else "\nALL GOOD", *errors, sep="\n  ")
sys.exit(1 if errors else 0)
