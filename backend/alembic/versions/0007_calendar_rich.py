"""calendar: categories, recurrence, ical sync fields

Revision ID: 0007_calendar_rich
Revises: 0006_session_kiosk
"""
import sqlalchemy as sa
from alembic import op

revision = "0007_calendar_rich"
down_revision = "0006_session_kiosk"
branch_labels = None
depends_on = None

_COLS = [
    ("end_time", sa.String(5), None),
    ("category", sa.String(24), "general"),
    ("location", sa.String(160), ""),
    ("recur", sa.String(12), "none"),
    ("recur_days", sa.String(20), ""),
    ("recur_until", sa.String(10), None),
    ("ical_uid", sa.String(255), None),
    ("source", sa.String(24), "local"),
]


def upgrade() -> None:
    for name, typ, default in _COLS:
        kw = {"server_default": default} if default is not None else {}
        op.add_column("calendar_events", sa.Column(name, typ, nullable=(default is None), **kw))
    op.create_index("ix_calendar_events_ical_uid", "calendar_events", ["ical_uid"])


def downgrade() -> None:
    op.drop_index("ix_calendar_events_ical_uid", "calendar_events")
    for name, _, _ in _COLS:
        op.drop_column("calendar_events", name)
