#!/usr/bin/env python3
"""
Import MP Models spreadsheets into the booking app.

Reads:
  - JOB TRACKER 2026.xlsx   -> data/jobs.json      (the jobs ledger)
  - 2026 SCHEDULE.xlsx      -> data/schedule.json  (day-by-day calendar)

Run:  python3 scripts/import-excel.py
      (optionally pass custom paths as the first two arguments)

Re-running overwrites the two JSON files, so it is safe to import again
after updating the spreadsheets.
"""

import sys, os, json, uuid, datetime
import openpyxl

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")

TRACKER = sys.argv[1] if len(sys.argv) > 1 else "/Users/lissa/Downloads/JOB TRACKER 2026.xlsx"
SCHEDULE = sys.argv[2] if len(sys.argv) > 2 else "/Users/lissa/Downloads/2026 SCHEDULE.xlsx"

MONTHS = {  # sheet name -> YYYY-MM
    "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
    "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}


def month_key(sheet_name):
    """'JULY 26' / 'AUG26' -> '2026-07'."""
    s = sheet_name.strip().upper()
    for k, v in MONTHS.items():
        if s.startswith(k):
            year = "".join(ch for ch in s if ch.isdigit())[-2:] or "26"
            return f"20{year}-{v}"
    return sheet_name


def as_text(v):
    if v is None:
        return ""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%Y-%m-%d")
    return str(v).strip()


def as_date(v):
    """A real date -> ISO string; a messy string like '18,19 May' -> kept as text."""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%Y-%m-%d")
    t = as_text(v)
    return "" if t in ("-", "") else t


def as_number(v):
    if isinstance(v, (int, float)):
        return float(v)
    return 0.0


# ---------------------------------------------------------------- JOBS
def import_jobs():
    wb = openpyxl.load_workbook(TRACKER, read_only=True, data_only=True)
    jobs = []
    for ws in wb.worksheets:
        mkey = month_key(ws.title)
        for row in list(ws.iter_rows(values_only=True))[1:]:  # skip header
            title = as_text(row[5]) if len(row) > 5 else ""
            # Skip blank rows and the grey "JOB IN JULY" separator rows.
            if not title or title.upper().startswith("JOB IN"):
                continue

            confirm_raw = as_text(row[10]) if len(row) > 10 else ""
            confirmed = confirm_raw.lower() in ("yes", "y", "/")

            jobs.append({
                "id": str(uuid.uuid4()),
                "source": "import",
                "month": mkey,
                "bookingDate": as_date(row[0]) if len(row) > 0 else "",
                "jobDate":     as_date(row[1]) if len(row) > 1 else "",
                "budget":      as_number(row[2]) if len(row) > 2 else 0.0,
                "jobId":       as_text(row[3]) if len(row) > 3 else "",
                "jobIdNonTax": as_text(row[4]) if len(row) > 4 else "",
                "jobTitle":    title,
                "model":       as_text(row[6]) if len(row) > 6 else "",
                "freelance":   as_text(row[7]) if len(row) > 7 else "",
                "client":      as_text(row[8]) if len(row) > 8 else "",
                "booker":      as_text(row[9]) if len(row) > 9 else "",
                "confirmed":   confirmed,
                "status":      "confirmed" if confirmed else "pending",
            })
    return jobs


# ------------------------------------------------------------ SCHEDULE
def import_schedule():
    wb = openpyxl.load_workbook(SCHEDULE, read_only=True, data_only=True)
    entries = []
    for ws in wb.worksheets:
        if ws.title.lower().startswith(("chart", "sheet")):
            continue
        mkey = month_key(ws.title)
        current_date = ""
        for row in list(ws.iter_rows(values_only=True))[1:]:
            date_cell = as_date(row[0]) if len(row) > 0 else ""
            if date_cell:
                current_date = date_cell
            models  = as_text(row[1]) if len(row) > 1 else ""
            casting = as_text(row[2]) if len(row) > 2 else ""
            option  = as_text(row[3]) if len(row) > 3 else ""
            job     = as_text(row[4]) if len(row) > 4 else ""
            if not (models or casting or option or job):
                continue
            entries.append({
                "id": str(uuid.uuid4()),
                "month": mkey,
                "date": current_date,
                "models": models,
                "casting": casting,
                "option": option,
                "job": job,
            })
    return entries


def main():
    os.makedirs(DATA, exist_ok=True)
    jobs = import_jobs()
    schedule = import_schedule()

    with open(os.path.join(DATA, "jobs.json"), "w") as f:
        json.dump(jobs, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, "schedule.json"), "w") as f:
        json.dump(schedule, f, ensure_ascii=False, indent=2)

    total_budget = sum(j["budget"] for j in jobs)
    print(f"Imported {len(jobs)} jobs  (total budget THB {total_budget:,.0f})")
    print(f"Imported {len(schedule)} schedule entries")
    print(f"Wrote {DATA}/jobs.json and {DATA}/schedule.json")


if __name__ == "__main__":
    main()
