#!/usr/bin/env python3
"""
Re-import ONLY the schedule from 2026 SCHEDULE.xlsx, reading each entry's
FONT COLOR to tag it with the booker who owns it:

  blue  -> Tawa    green -> Ness    magenta/pink -> Emmy
  black -> Lisa    grey  -> Wolf    (red/cyan/other -> untagged)

Leaves data/jobs.json untouched. Run: python3 scripts/import-schedule-colors.py
"""
import sys, os, json, uuid, datetime
import openpyxl

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
SCHEDULE = sys.argv[1] if len(sys.argv) > 1 else "/Users/lissa/Downloads/2026 SCHEDULE.xlsx"

MONTHS = {"JAN":"01","FEB":"02","MAR":"03","APR":"04","MAY":"05","JUN":"06",
          "JUL":"07","AUG":"08","SEP":"09","OCT":"10","NOV":"11","DEC":"12"}

def month_key(name):
    s = name.strip().upper()
    for k, v in MONTHS.items():
        if s.startswith(k):
            year = "".join(ch for ch in s if ch.isdigit())[-2:] or "26"
            return f"20{year}-{v}"
    return name

def as_text(v):
    if v is None: return ""
    if isinstance(v, (datetime.datetime, datetime.date)): return v.strftime("%Y-%m-%d")
    return str(v).strip()

def as_date(v):
    if isinstance(v, (datetime.datetime, datetime.date)): return v.strftime("%Y-%m-%d")
    t = as_text(v)
    return "" if t in ("-", "") else t

def rgb6(cell):
    col = cell.font.color
    if col is None: return None
    if col.type == "rgb" and isinstance(col.rgb, str):
        return col.rgb[-6:].upper()
    return None  # theme / indexed / none -> treat as no explicit colour

PRIORITY_WORDS = ("visa", "work permit", "permit", " wp", "passport", "immigration",
                  "embassy", "90 day", "90-day", "re-entry", "re entry", "reentry",
                  "pick up", "pickup", "documents", "certificate of residence")
def is_priority(text_val):
    """Red text about an admin task (visa/work-permit) = Priority, not a shortlist."""
    t = (text_val or "").lower()
    return any(w in t for w in PRIORITY_WORDS)

def is_red(hex6):
    """Red font = a hold (Shortlist or Priority), not a booker."""
    if not hex6: return False
    try:
        r, g, b = int(hex6[0:2],16), int(hex6[2:4],16), int(hex6[4:6],16)
    except ValueError:
        return False
    return r >= 120 and g < 95 and b < 95

def booker_from_hex(hex6):
    if not hex6: return ""
    try:
        r, g, b = int(hex6[0:2],16), int(hex6[2:4],16), int(hex6[4:6],16)
    except ValueError:
        return ""
    # grey / black (all channels close)
    if abs(r-g) <= 22 and abs(g-b) <= 22 and abs(r-b) <= 22:
        if r < 45:  return "Lisa"   # black
        if r < 200: return "Wolf"   # grey
        return ""                   # near-white
    if b > r and b >= g and b > 60:            return "Tawa"   # blue
    if g > r and g >= b:                        return "Ness"   # green
    if r >= 100 and b >= 100 and g < r and g < b + 30: return "Emmy"  # magenta / pink
    return ""   # red, cyan, etc. -> highlight, not a booker

def row_booker(cells):
    # The booker colour lives on a non-red casting/option/job cell (then models).
    for c in cells:
        if c.value not in (None, ""):
            hx = rgb6(c)
            if is_red(hx):
                continue          # red = shortlist, not a booker
            b = booker_from_hex(hx)
            if b:
                return b
    return ""

def main():
    wb = openpyxl.load_workbook(SCHEDULE, data_only=True)
    entries = []
    tally = {}
    for ws in wb.worksheets:
        if ws.title.lower().startswith(("chart", "sheet")):
            continue
        mkey = month_key(ws.title)
        current_date = ""
        rows = list(ws.iter_rows())
        for row in rows[1:]:
            cell = lambda i: row[i] if len(row) > i else None
            date_cell = cell(0)
            if date_cell is not None and as_date(date_cell.value):
                current_date = as_date(date_cell.value)
            models  = as_text(cell(1).value) if cell(1) else ""
            if not (models or as_text(cell(2).value if cell(2) else "")
                    or as_text(cell(3).value if cell(3) else "")
                    or as_text(cell(4).value if cell(4) else "")):
                continue

            # Split casting/option/job by colour. RED text = a hold; if it mentions
            # a visa / work-permit / immigration task it's a PRIORITY (admin task),
            # otherwise it's a SHORTLIST. Non-red text stays in its column.
            fields = {"casting": "", "option": "", "job": ""}
            shortlist_parts, priority_parts = [], []

            def file_red(val):
                (priority_parts if is_priority(val) else shortlist_parts).append(val)

            for idx, name in [(2, "casting"), (3, "option"), (4, "job")]:
                c = cell(idx)
                val = as_text(c.value) if c else ""
                if not val:
                    continue
                if is_red(rgb6(c)):
                    file_red(val)
                else:
                    fields[name] = val
            # A red models cell means those models are held/tasked.
            if cell(1) is not None and models and is_red(rgb6(cell(1))):
                file_red(models)

            order = [cell(2), cell(3), cell(4), cell(1)]
            booker = row_booker([c for c in order if c is not None])
            # Priority (visa / work-permit) tasks are handled by the Admin.
            if priority_parts:
                booker = "Admin"
            tally[booker or "(untagged)"] = tally.get(booker or "(untagged)", 0) + 1
            entries.append({
                "id": str(uuid.uuid4()),
                "month": mkey,
                "date": current_date,
                "booker": booker,
                "status": "open",
                "models": models,
                "casting": fields["casting"],
                "option": fields["option"],
                "job": fields["job"],
                "shortlist": "\n".join(shortlist_parts),
                "priority": "\n".join(priority_parts),
                "note": "",
            })

    with open(os.path.join(DATA, "schedule.json"), "w") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    print(f"Imported {len(entries)} schedule entries with booker colours.")
    print("Booker tally:", dict(sorted(tally.items(), key=lambda x: -x[1])))

if __name__ == "__main__":
    main()
