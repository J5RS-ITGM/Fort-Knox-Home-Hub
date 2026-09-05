"""calendar: google_id column

Revision ID: 0008_google_id
Revises: 0007_calendar_rich
"""
import sqlalchemy as sa
from alembic import op

revision = "0008_google_id"
down_revision = "0007_calendar_rich"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("calendar_events", sa.Column("google_id", sa.String(255), nullable=True))
    op.create_index("ix_calendar_events_google_id", "calendar_events", ["google_id"])


def downgrade() -> None:
    op.drop_index("ix_calendar_events_google_id", "calendar_events")
    op.drop_column("calendar_events", "google_id")
