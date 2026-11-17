"""PDF and Excel exports for place and country reports.

The PDF is built section by section so the caller can choose which parts to include.
"""
from datetime import datetime
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    CondPageBreak,
    Flowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

LOGO_PATH = Path(__file__).resolve().parent / "static" / "img" / "agnes-logo.png"

GREEN = colors.HexColor("#0f5a36")
GREEN_DEEP = colors.HexColor("#06261c")
GREEN_SOFT = colors.HexColor("#eef4ef")
INK = colors.HexColor("#0f1f1a")
MUTED = colors.HexColor("#5a6b63")
LINE = colors.HexColor("#d9e2dc")
TRACK = colors.HexColor("#e4ebe6")
BAR = colors.HexColor("#1f6f52")
BAR_RISK = colors.HexColor("#d9632b")
BAR_GOOD = colors.HexColor("#1f9d6b")
AMBER_SOFT = colors.HexColor("#fff4d6")

RISK_COLORS = {
    "Very High": colors.HexColor("#b91c1c"),
    "High": colors.HexColor("#ef4444"),
    "Medium": colors.HexColor("#f59e0b"),
    "Low": colors.HexColor("#84cc16"),
    "Very Low": colors.HexColor("#16a34a"),
}
RISK_ORDER = ["Very High", "High", "Medium", "Low", "Very Low"]
RISK_RANGES = ["75 and above", "60 to 74", "40 to 59", "20 to 39", "Below 20"]
THRESHOLDS = (20, 40, 60, 75)

# Kept in step with DRIVER_ACTIONS in static/js/map.js.
DRIVER_ACTIONS = {
    "Water": {
        "exposure": "Prioritise drought- and flood-resilient water sources (protected boreholes, storage, rainwater harvesting) sited with women's user groups.",
        "sensitivity": "Shorten collection distances with nearer water points and household connections, and track women's and girls' collection time as a programme result.",
        "capacity": "Expand safe water coverage and put women on water committees with real say over tariffs, siting, and maintenance budgets.",
    },
    "Energy": {
        "exposure": "Protect energy supply chains and woodland resources from climate shocks, and plan for clean-fuel access during drought and flood periods.",
        "sensitivity": "Reduce firewood dependence through improved cookstoves, LPG and biogas access, and woodlot schemes managed by women's groups.",
        "capacity": "Scale grid, mini-grid, and solar connections with financing women can access, and open energy-sector jobs and enterprise support to women.",
    },
    "Agriculture": {
        "exposure": "Roll out climate information services, drought-tolerant seed, and small-scale irrigation that reach women farmers directly.",
        "sensitivity": "Diversify women's income beyond rain-fed farming through value addition, market access, and off-farm enterprise support.",
        "capacity": "Strengthen women's land rights through joint titling and registration, and link secure tenure to credit, inputs, and extension.",
    },
}

COMPONENTS = [
    ("exposure", "Exposure", "Climate hazards such as drought, flood, and heat", BAR_RISK),
    ("sensitivity", "Sensitivity", "How far women's work and income depend on this resource", BAR_RISK),
    ("adaptive_capacity", "Adaptive capacity", "Access and assets that help women cope. Higher is better", BAR_GOOD),
]

PLACE_SECTIONS = [
    ("summary", "Headline score and summary"),
    ("sectors", "Sector breakdown and indicators"),
    ("priorities", "Suggested priorities"),
    ("figures", "Table of all figures"),
    ("analysis", "Written analysis and documents"),
    ("guide", "Reading guide and data source"),
]
COUNTRY_SECTIONS = [
    ("summary", "Country summary"),
    ("sectors", "Sector averages and risk mix"),
    ("table", "Full table of places"),
    ("guide", "Reading guide and data source"),
]


# ---------------------------------------------------------------- helpers
def fmt(value):
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError):
        return "N/A"


def mean(values):
    numbers = [float(v) for v in values if v is not None]
    return sum(numbers) / len(numbers) if numbers else None


def esc(text):
    return str(text if text is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def lead_driver(metrics):
    capacity = metrics.get("adaptive_capacity")
    drivers = [
        ("exposure", "climate exposure", metrics.get("exposure")),
        ("sensitivity", "gendered sensitivity", metrics.get("sensitivity")),
        ("capacity", "low adaptive capacity", None if capacity is None else 100 - capacity),
    ]
    drivers = [d for d in drivers if d[2] is not None]
    return max(drivers, key=lambda d: d[2]) if drivers else None


def sector_average(records, sector):
    return mean((r.get("metrics", {}).get(sector) or {}).get("gender_hotspot_score") for r in records)


def rank_of(record, records):
    peers = sorted((r for r in records if r.get("composite_score") is not None), key=lambda r: -r["composite_score"])
    for index, item in enumerate(peers, start=1):
        if item["name"] == record["name"]:
            return index, len(peers)
    return None, len(peers)


def data_source_sentence(country, illustrative, status=None):
    if illustrative:
        return (f"Figures for {country} are illustrative placeholders, not survey results. "
                f"They are replaced when the {country} sector workbooks are uploaded.")
    if status == "uploaded":
        return "Figures come from sector workbooks uploaded through the admin dashboard."
    return "Figures come from the supplied water, energy, and agriculture sector workbooks."


def data_status_label(record):
    return {"illustrative": "Illustrative", "uploaded": "Uploaded workbook"}.get(record.get("data_status"), "Sector workbooks")


def split_indicator(text):
    label, sep, value = str(text).partition(": ")
    return (label, value) if sep else (label, "")


# ---------------------------------------------------------------- PDF pieces
STYLES = {
    "eyebrow": ParagraphStyle("eyebrow", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=GREEN, spaceAfter=2),
    "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=GREEN_DEEP),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=GREEN_DEEP, spaceAfter=3),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=INK),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.5, leading=14, textColor=INK, alignment=TA_LEFT),
    "muted": ParagraphStyle("muted", fontName="Helvetica", fontSize=8.5, leading=12, textColor=MUTED),
    "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8, leading=11, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.5, leading=11, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=INK),
    "white": ParagraphStyle("white", fontName="Helvetica", fontSize=10, leading=15, textColor=colors.white),
    "whitecap": ParagraphStyle("whitecap", fontName="Helvetica-Bold", fontSize=7, leading=9, textColor=colors.HexColor("#cfe5d8")),
    "whiteval": ParagraphStyle("whiteval", fontName="Helvetica-Bold", fontSize=12, leading=15, textColor=colors.white),
    "score": ParagraphStyle("score", fontName="Helvetica-Bold", fontSize=38, leading=40, textColor=colors.white),
}


class Meter(Flowable):
    """Horizontal 0-100 bar with marks at the risk thresholds."""

    def __init__(self, value, width, height=5, fill=BAR, track=TRACK, tick=colors.white):
        super().__init__()
        self.value, self.width, self.height = value, width, height
        self.fill, self.track, self.tick = fill, track, tick

    def wrap(self, *_):
        return self.width, self.height

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(self.track)
        canvas.roundRect(0, 0, self.width, self.height, 1.2, stroke=0, fill=1)
        try:
            share = max(0.0, min(100.0, float(self.value))) / 100
        except (TypeError, ValueError):
            share = 0
        if share:
            canvas.setFillColor(self.fill)
            canvas.roundRect(0, 0, self.width * share, self.height, 1.2, stroke=0, fill=1)
        canvas.setFillColor(self.tick)
        for mark in THRESHOLDS:
            canvas.rect(self.width * mark / 100 - 0.4, 0, 0.8, self.height, stroke=0, fill=1)


class RiskMix(Flowable):
    """Stacked strip showing how many places fall in each risk class."""

    def __init__(self, counts, width, height=7):
        super().__init__()
        self.counts, self.width, self.height = counts, width, height

    def wrap(self, *_):
        return self.width, self.height

    def draw(self):
        total = sum(count for _, count in self.counts) or 1
        x = 0
        for risk, count in self.counts:
            width = self.width * count / total
            self.canv.setFillColor(RISK_COLORS[risk])
            self.canv.rect(x, 0, max(width - 1, 0.5), self.height, stroke=0, fill=1)
            x += width


def risk_text(risk, style="cell"):
    color = RISK_COLORS.get(risk, MUTED)
    return Paragraph(f'<font color="{color.hexval()}">&#9679;</font> {esc(risk or "No data")}', STYLES[style])


def section_head(eyebrow, title, note=""):
    # Start a new page rather than leave a heading stranded at the bottom of one.
    parts = [CondPageBreak(48 * mm), Spacer(1, 7 * mm), Paragraph(esc(eyebrow.upper()), STYLES["eyebrow"]), Paragraph(esc(title), STYLES["h2"])]
    if note:
        parts.append(Paragraph(esc(note), STYLES["muted"]))
    parts.append(Spacer(1, 3 * mm))
    return parts


def hero(width, label, score, body_flowables, facts):
    inner = width - 14 * mm
    left = [
        Paragraph(esc(label).upper(), STYLES["whitecap"]),
        Paragraph(f'{fmt(score)} <font size="12" color="#cfe5d8">/ 100</font>', STYLES["score"]),
        Spacer(1, 2 * mm),
        Meter(score, inner * 0.44, height=6, fill=colors.HexColor("#6ee7a8"), track=colors.HexColor("#3f7d5c"), tick=GREEN),
        Spacer(1, 1.5 * mm),
        Paragraph("0 &nbsp;&nbsp; Low 20 &nbsp;&nbsp; Medium 40 &nbsp;&nbsp; High 60 &nbsp;&nbsp; Very high 75", ParagraphStyle("scale", parent=STYLES["whitecap"], fontName="Helvetica")),
    ]
    top = Table([[left, body_flowables]], colWidths=[inner * 0.48, inner * 0.52])
    top.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
    fact_cells = [[Paragraph(esc(name).upper(), STYLES["whitecap"]), Paragraph(esc(value), STYLES["whiteval"])] for name, value in facts]
    fact_table = Table([fact_cells], colWidths=[inner / len(fact_cells)] * len(fact_cells))
    fact_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#27704c")),
        ("LINEAFTER", (0, 0), (-2, -1), 3, GREEN),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    card = Table([[top], [fact_table]], colWidths=[width])
    card.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 7 * mm), ("RIGHTPADDING", (0, 0), (-1, -1), 7 * mm),
        ("TOPPADDING", (0, 0), (0, 0), 7 * mm), ("BOTTOMPADDING", (0, 0), (0, 0), 5 * mm),
        ("TOPPADDING", (0, 1), (0, 1), 0), ("BOTTOMPADDING", (0, 1), (0, 1), 7 * mm),
        ("ROUNDEDCORNERS", [6, 6, 6, 6]),
    ]))
    return card


def data_table(rows, col_widths, numeric_from=1, header_rows=1, footer=False):
    table = Table(rows, colWidths=col_widths, repeatRows=header_rows)
    style = [
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, 0), 7),
        ("TEXTCOLOR", (0, 0), (-1, 0), MUTED), ("BACKGROUND", (0, 0), (-1, 0), GREEN_SOFT),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"), ("FONTSIZE", (0, 1), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    if footer:
        style += [("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"), ("BACKGROUND", (0, -1), (-1, -1), GREEN_SOFT), ("LINEABOVE", (0, -1), (-1, -1), 0.9, MUTED)]
    table.setStyle(TableStyle(style))
    return table


def reading_guide(width, source_text, illustrative):
    classes = [[risk_text(risk), Paragraph(span, STYLES["cell"])] for risk, span in zip(RISK_ORDER, RISK_RANGES)]
    class_table = Table(classes, colWidths=[32 * mm, 30 * mm])
    class_table.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE), ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    left = [
        Paragraph("What the score means", STYLES["h3"]), Spacer(1, 1.5 * mm),
        Paragraph("The hotspot score is the average of exposure, sensitivity, and the gap in adaptive capacity (100 minus capacity). A higher score means climate pressure and gender vulnerability combine more severely.", STYLES["muted"]),
        Spacer(1, 2 * mm), class_table,
    ]
    right = [
        Paragraph("Illustrative data" if illustrative else "Data source", STYLES["h3"]), Spacer(1, 1.5 * mm),
        Paragraph(esc(source_text), STYLES["muted"]), Spacer(1, 2 * mm),
        Paragraph("Scores compare places within the study. They show where to look first and do not replace local assessment.", STYLES["muted"]),
    ]
    table = Table([[left, right]], colWidths=[width * 0.54, width * 0.46])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOX", (0, 0), (0, 0), 0.6, LINE), ("BOX", (1, 0), (1, 0), 0.6, LINE),
        ("BACKGROUND", (1, 0), (1, 0), AMBER_SOFT if illustrative else colors.white),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
    ]))
    return table


def build_document(story, title, subtitle):
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=26 * mm, bottomMargin=18 * mm, title=title, author="AGNES Gender Hotspot Map")
    stamp = datetime.now().strftime("%d %B %Y")

    def decorate(canvas, document):
        canvas.saveState()
        page_width, page_height = A4
        if LOGO_PATH.exists():
            canvas.drawImage(str(LOGO_PATH), 16 * mm, page_height - 19 * mm, width=26 * mm, height=10.8 * mm, mask="auto")
        canvas.setFont("Helvetica-Bold", 9)
        canvas.setFillColor(GREEN_DEEP)
        canvas.drawRightString(page_width - 16 * mm, page_height - 13 * mm, "Gender Hotspot Map")
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(page_width - 16 * mm, page_height - 17 * mm, subtitle)
        canvas.setStrokeColor(GREEN)
        canvas.setLineWidth(1.2)
        canvas.line(16 * mm, page_height - 22 * mm, page_width - 16 * mm, page_height - 22 * mm)
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(16 * mm, 13 * mm, page_width - 16 * mm, 13 * mm)
        canvas.drawString(16 * mm, 9 * mm, f"AGNES Gender Hotspot Map  |  Generated {stamp}")
        canvas.drawRightString(page_width - 16 * mm, 9 * mm, f"Page {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return buffer.getvalue()


# ---------------------------------------------------------------- place PDF
def place_pdf(record, records, country_meta, sectors, selected=None):
    wanted = set(selected or [key for key, _ in PLACE_SECTIONS])
    width = A4[0] - 32 * mm
    country = record["country"]
    place_label = country_meta.get("place_label", "Place")
    admin = country_meta.get("admin_label", "places").lower()
    rank, total = rank_of(record, records)
    illustrative = record.get("data_status") == "illustrative"
    inner = width - 20  # sector cards have 10pt padding on each side

    story = [
        Paragraph(esc(f"{country} \u00b7 {place_label} report".upper()), STYLES["eyebrow"]),
        Paragraph(esc(record["name"]), STYLES["title"]),
        Spacer(1, 4 * mm),
    ]

    if "summary" in wanted:
        summary = f"{record['name']} scores {fmt(record.get('composite_score'))} out of 100, which places it in the {record.get('risk_level')} risk class."
        if rank:
            summary += f" It ranks {rank} of {total} {admin} in {country}, where 1 is the most severe hotspot."
        if record.get("top_sector"):
            summary += f" {record['top_sector']} is the sector under the most pressure."
        story.append(hero(
            width, "Composite gender hotspot score", record.get("composite_score"),
            [Paragraph(f"<b>{esc(record.get('risk_level') or 'No data')} risk</b>", STYLES["white"]), Spacer(1, 1.5 * mm), Paragraph(esc(summary), STYLES["white"])],
            [
                (f"Rank in {country}", f"{rank} of {total}" if rank else "N/A"),
                (f"{country} average", fmt(mean(r.get("composite_score") for r in records))),
                ("Strongest pressure", record.get("top_sector") or "N/A"),
                ("Data source", data_status_label(record)),
            ],
        ))

    if "sectors" in wanted:
        story += section_head("Sector by sector", "Where the pressure comes from", "Each sector has its own 0 to 100 hotspot score, built from exposure, sensitivity, and adaptive capacity.")
        for sector in sectors:
            metrics = (record.get("metrics") or {}).get(sector) or {}
            if metrics.get("gender_hotspot_score") is None:
                continue
            driver = lead_driver(metrics)
            average = sector_average(records, sector)
            gap = None if average is None else metrics["gender_hotspot_score"] - average
            compare = "" if gap is None else f"<b>{'+' if gap > 0 else ''}{gap:.1f}</b> against the {esc(country)} average of {fmt(average)}."
            if driver:
                compare += f" Main driver: <b>{esc(driver[1])}</b>."
            head = Table([[
                Paragraph(f"<b>{esc(sector)}</b>" + (' &nbsp;<font size="7.5" color="#14694b">STRONGEST PRESSURE</font>' if record.get("top_sector") == sector else ""), ParagraphStyle("sh", parent=STYLES["h3"], fontSize=12)),
                risk_text(metrics.get("risk_level")),
                Paragraph(f"<b>{fmt(metrics['gender_hotspot_score'])}</b>", ParagraphStyle("ss", parent=STYLES["h3"], fontSize=15, alignment=2)),
            ]], colWidths=[inner - 50 * mm, 30 * mm, 20 * mm])
            head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
            component_rows = [[
                [Paragraph(f"<b>{label}</b>", STYLES["cell"]), Paragraph(help_text, STYLES["small"])],
                Meter(metrics.get(key), 58 * mm, fill=fill),
                Paragraph(f"<b>{fmt(metrics.get(key))}</b>", ParagraphStyle("cv", parent=STYLES["cell"], alignment=2)),
            ] for key, label, help_text, fill in COMPONENTS]
            components = Table(component_rows, colWidths=[inner - 78 * mm, 62 * mm, 16 * mm])
            components.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("LINEABOVE", (0, 0), (-1, 0), 0.4, LINE)]))
            block = [head, Spacer(1, 1 * mm), Paragraph(compare, STYLES["muted"]), Spacer(1, 2 * mm), components]
            indicators = [split_indicator(item) for item in metrics.get("indicators") or []]
            if indicators:
                rows = [[Paragraph(esc(label), STYLES["cell"]), Paragraph(f"<b>{esc(value)}</b>", ParagraphStyle("iv", parent=STYLES["cell"], alignment=2))] for label, value in indicators]
                indicator_table = Table(rows, colWidths=[inner - 34 * mm, 34 * mm])
                indicator_table.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 0.3, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
                block += [Spacer(1, 1.5 * mm), indicator_table]
            card = Table([[block]], colWidths=[width])
            card.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9), ("ROUNDEDCORNERS", [5, 5, 5, 5])]))
            story += [KeepTogether([card]), Spacer(1, 3 * mm)]

    if "priorities" in wanted:
        ranked = sorted((s for s in sectors if ((record.get("metrics") or {}).get(s) or {}).get("gender_hotspot_score") is not None), key=lambda s: -record["metrics"][s]["gender_hotspot_score"])
        items = []
        for number, sector in enumerate(ranked, start=1):
            metrics = record["metrics"][sector]
            driver = lead_driver(metrics)
            action = DRIVER_ACTIONS.get(sector, {}).get(driver[0]) if driver else None
            if not action:
                continue
            items.append(KeepTogether([
                Paragraph(f'<font color="{GREEN.hexval()}"><b>{number}.</b></font> &nbsp;<b>{esc(sector)}</b> &nbsp;<font size="8" color="{MUTED.hexval()}">{fmt(metrics["gender_hotspot_score"])} &middot; {esc(metrics.get("risk_level"))}</font>', STYLES["h3"]),
                Paragraph(esc(action), ParagraphStyle("pa", parent=STYLES["body"], leftIndent=14, spaceBefore=2)),
                Paragraph(f"Suggested because the main driver is {esc(driver[1])}.", ParagraphStyle("pm", parent=STYLES["small"], leftIndent=14, spaceBefore=1, spaceAfter=7)),
            ]))
        if items:
            story += section_head("Suggested priorities", "Where to act first", "Ordered from the highest sector score. These are starting points drawn from the figures, not a full programme design.")
            story += items

    if "figures" in wanted:
        story += section_head("All figures", "The numbers behind this report", "All values are on a 0 to 100 scale.")
        rows = [["SECTOR", "HOTSPOT", "RISK CLASS", "VULNERABILITY", "EXPOSURE", "SENSITIVITY", "ADAPTIVE CAPACITY"]]
        for sector in sectors:
            metrics = (record.get("metrics") or {}).get(sector) or {}
            rows.append([sector, fmt(metrics.get("gender_hotspot_score")), risk_text(metrics.get("risk_level")), fmt(metrics.get("vulnerability_score")), fmt(metrics.get("exposure")), fmt(metrics.get("sensitivity")), fmt(metrics.get("adaptive_capacity"))])
        rows.append(["Composite", fmt(record.get("composite_score")), risk_text(record.get("risk_level"), "cellb"), "", "", "", ""])
        story.append(data_table(rows, [27 * mm, 19 * mm, 27 * mm, 26 * mm, 20 * mm, 22 * mm, width - 141 * mm], footer=True))

    if "analysis" in wanted:
        blocks = []
        for report in record.get("reports") or []:
            blocks.append(Paragraph(esc(report.get("title") or "Report"), STYLES["h3"]))
            for heading, key in (("Overview", "overview"), ("Key findings", "findings"), ("Recommendations", "recommendations"), ("Methodology and notes", "methodology")):
                text = (report.get(key) or "").strip()
                if text:
                    blocks.append(Paragraph(f"<b>{heading}</b>", ParagraphStyle("rh", parent=STYLES["cell"], spaceBefore=5)))
                    blocks += [Paragraph(esc(line), STYLES["body"]) for line in text.splitlines() if line.strip()]
            blocks.append(Spacer(1, 3 * mm))
        for sector, item in (record.get("ai_narratives") or {}).items():
            overview = ((item or {}).get("narrative") or {}).get("overview")
            if overview:
                blocks += [Paragraph(f"AI-drafted {esc(sector)} narrative", STYLES["h3"]), Paragraph(esc(overview), STYLES["body"]), Spacer(1, 3 * mm)]
        documents = record.get("documents") or []
        if documents:
            blocks.append(Paragraph("Attached documents", STYLES["h3"]))
            blocks += [Paragraph(f"&bull; {esc(doc.get('title'))} ({esc(doc.get('sector') or 'All sectors')})", STYLES["body"]) for doc in documents]
        if not blocks:
            blocks.append(Paragraph("No written report, AI narrative, or document has been published for this place yet.", STYLES["muted"]))
        story += section_head("Analysis and documents", "Written analysis for this place") + blocks

    if "guide" in wanted:
        story += section_head("Reading guide", "How to read these figures")
        story.append(reading_guide(width, data_source_sentence(country, illustrative, record.get("data_status")), illustrative))

    return build_document(story, f"{record['name']} gender hotspot report", f"{record['name']}, {country}")


# ---------------------------------------------------------------- country PDF
def country_pdf(country_meta, records, sectors, selected=None):
    wanted = set(selected or [key for key, _ in COUNTRY_SECTIONS])
    width = A4[0] - 32 * mm
    country = country_meta["country"]
    admin = country_meta.get("admin_label", "Places")
    illustrative = bool(country_meta.get("illustrative"))
    priority = sum(1 for r in records if r.get("risk_level") in ("High", "Very High"))
    sector_means = [(sector, sector_average(records, sector)) for sector in sectors]
    sector_means = [(sector, value) for sector, value in sector_means if value is not None]
    top = max(sector_means, key=lambda item: item[1]) if sector_means else None
    mix = [(risk, sum(1 for r in records if r.get("risk_level") == risk)) for risk in RISK_ORDER]
    mix = [(risk, count) for risk, count in mix if count]

    story = [
        Paragraph(esc(f"{country} \u00b7 country data".upper()), STYLES["eyebrow"]),
        Paragraph(f"{esc(country)}: all {esc(admin.lower())}", STYLES["title"]),
        Spacer(1, 4 * mm),
    ]

    if "summary" in wanted:
        text = f"{priority} of {len(records)} {admin.lower()} are classed High or Very High."
        if top:
            text += f" {top[0]} carries the highest average pressure at {fmt(top[1])}."
        story.append(hero(
            width, "Average composite score", mean(r.get("composite_score") for r in records),
            [Paragraph(esc(text), STYLES["white"])],
            [(admin, str(len(records)))] + [(f"{sector} average", fmt(value)) for sector, value in sector_means],
        ))

    if "sectors" in wanted:
        story += section_head("Sectors and risk", "Sector averages and risk class mix")
        rows = [[Paragraph(f"<b>{esc(sector)}</b>", STYLES["cell"]), Meter(value, 90 * mm, height=6), Paragraph(f"<b>{fmt(value)}</b>", ParagraphStyle("sv", parent=STYLES["cell"], alignment=2))] for sector, value in sector_means]
        if rows:
            table = Table(rows, colWidths=[40 * mm, 96 * mm, width - 136 * mm])
            table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
            story += [table, Spacer(1, 4 * mm)]
        if mix:
            story += [Table([[RiskMix(mix, width - 12)]], colWidths=[width]), Spacer(1, 1 * mm)]
            legend = " &nbsp;&nbsp; ".join(f'<font color="{RISK_COLORS[risk].hexval()}">&#9679;</font> {risk} <b>{count}</b>' for risk, count in mix)
            story.append(Paragraph(legend, ParagraphStyle("mixkey", parent=STYLES["cell"], leftIndent=6)))

    if "table" in wanted:
        story += section_head("Full dataset", f"Every {country_meta.get('place_label', 'place').lower()} and its sector scores", "Ordered from the highest composite score. All values are on a 0 to 100 scale.")
        ordered = sorted(records, key=lambda r: -(r.get("composite_score") or 0))
        rows = [["#", country_meta.get("place_label", "Place").upper(), "COMPOSITE", "RISK CLASS"] + [s.upper() for s in sectors] + ["STRONGEST PRESSURE"]]
        for index, record in enumerate(ordered, start=1):
            rows.append([str(index), Paragraph(f"<b>{esc(record['name'])}</b>", STYLES["cell"]), fmt(record.get("composite_score")), risk_text(record.get("risk_level"))]
                        + [fmt(((record.get("metrics") or {}).get(sector) or {}).get("gender_hotspot_score")) for sector in sectors]
                        + [record.get("top_sector") or "N/A"])
        fixed = 9 * mm + 22 * mm + 27 * mm + 22 * mm * len(sectors) + 34 * mm
        story.append(data_table(rows, [9 * mm, width - fixed, 22 * mm, 27 * mm] + [22 * mm] * len(sectors) + [34 * mm]))

    if "guide" in wanted:
        story += section_head("Reading guide", "How to read these figures")
        story.append(reading_guide(width, data_source_sentence(country, illustrative), illustrative))

    return build_document(story, f"{country} gender hotspot data", f"{country}, all {admin.lower()}")


# ---------------------------------------------------------------- Excel
HEAD_FILL = PatternFill("solid", fgColor="0F5A36")
HEAD_FONT = Font(bold=True, color="FFFFFF")


def _sheet(workbook, title, header, rows, widths):
    sheet = workbook.create_sheet(title)
    sheet.append(header)
    for cell in sheet[1]:
        cell.fill, cell.font = HEAD_FILL, HEAD_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for row in rows:
        sheet.append(row)
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.freeze_panes = "A2"
    return sheet


def _workbook_bytes(workbook):
    del workbook[workbook.sheetnames[0]]
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def place_xlsx(record, records, country_meta, sectors):
    workbook = Workbook()
    country = record["country"]
    rank, total = rank_of(record, records)
    _sheet(workbook, "Summary", ["Item", "Value"], [
        ["Place", record["name"]], ["Country", country], ["Type", country_meta.get("place_label", "")],
        ["Composite gender hotspot score (0-100)", record.get("composite_score")], ["Risk class", record.get("risk_level")],
        [f"Rank in {country} (1 = most severe)", f"{rank} of {total}" if rank else "N/A"],
        [f"{country} average composite score", round(mean(r.get("composite_score") for r in records) or 0, 1)],
        ["Strongest pressure", record.get("top_sector")], ["Data source", data_status_label(record)],
        ["Note", data_source_sentence(country, record.get("data_status") == "illustrative", record.get("data_status"))],
        ["Generated", datetime.now().strftime("%Y-%m-%d %H:%M")],
    ], [42, 70])
    figure_rows, indicator_rows, priority_rows = [], [], []
    for sector in sectors:
        metrics = (record.get("metrics") or {}).get(sector) or {}
        average = sector_average(records, sector)
        driver = lead_driver(metrics)
        figure_rows.append([sector, metrics.get("gender_hotspot_score"), metrics.get("risk_level"), metrics.get("vulnerability_score"), metrics.get("exposure"), metrics.get("sensitivity"), metrics.get("adaptive_capacity"), None if average is None else round(average, 1), driver[1] if driver else ""])
        indicator_rows += [[sector, *split_indicator(item)] for item in metrics.get("indicators") or []]
        if driver and metrics.get("gender_hotspot_score") is not None:
            priority_rows.append([sector, metrics.get("gender_hotspot_score"), driver[1], DRIVER_ACTIONS.get(sector, {}).get(driver[0], "")])
    priority_rows.sort(key=lambda row: -(row[1] or 0))
    _sheet(workbook, "Sector figures", ["Sector", "Hotspot score", "Risk class", "Vulnerability", "Exposure", "Sensitivity", "Adaptive capacity", f"{country} sector average", "Main driver"], figure_rows, [16, 14, 14, 14, 12, 12, 18, 24, 24])
    _sheet(workbook, "Indicators", ["Sector", "Indicator", "Value"], indicator_rows, [16, 46, 18])
    sheet = _sheet(workbook, "Priorities", ["Sector", "Hotspot score", "Main driver", "Suggested priority"], priority_rows, [16, 14, 24, 110])
    for row in sheet.iter_rows(min_row=2):
        row[3].alignment = Alignment(wrap_text=True, vertical="top")
    return _workbook_bytes(workbook)


def country_xlsx(country_meta, records, sectors):
    workbook = Workbook()
    country = country_meta["country"]
    priority = sum(1 for r in records if r.get("risk_level") in ("High", "Very High"))
    summary = [
        ["Country", country], [country_meta.get("admin_label", "Places"), len(records)],
        ["Average composite score (0-100)", round(mean(r.get("composite_score") for r in records) or 0, 1)],
        ["High or Very High", priority],
    ]
    summary += [[f"{sector} average hotspot score", round(sector_average(records, sector) or 0, 1)] for sector in sectors]
    summary += [[f"{risk} places", sum(1 for r in records if r.get("risk_level") == risk)] for risk in RISK_ORDER]
    summary += [["Note", data_source_sentence(country, bool(country_meta.get("illustrative")))], ["Generated", datetime.now().strftime("%Y-%m-%d %H:%M")]]
    _sheet(workbook, "Summary", ["Item", "Value"], summary, [38, 70])

    fields = [("gender_hotspot_score", "hotspot score"), ("risk_level", "risk class"), ("vulnerability_score", "vulnerability"), ("exposure", "exposure"), ("sensitivity", "sensitivity"), ("adaptive_capacity", "adaptive capacity")]
    header = ["Rank", country_meta.get("place_label", "Place"), "Composite score", "Risk class", "Strongest pressure", "Data source"]
    header += [f"{sector} {label}" for sector in sectors for _, label in fields]
    rows = []
    for index, record in enumerate(sorted(records, key=lambda r: -(r.get("composite_score") or 0)), start=1):
        row = [index, record["name"], record.get("composite_score"), record.get("risk_level"), record.get("top_sector"), data_status_label(record)]
        row += [((record.get("metrics") or {}).get(sector) or {}).get(field) for sector in sectors for field, _ in fields]
        rows.append(row)
    sheet = _sheet(workbook, "All places", header, rows, [7, 26, 16, 14, 20, 18] + [15] * (len(sectors) * len(fields)))
    sheet.row_dimensions[1].height = 32
    sheet.auto_filter.ref = sheet.dimensions
    return _workbook_bytes(workbook)
