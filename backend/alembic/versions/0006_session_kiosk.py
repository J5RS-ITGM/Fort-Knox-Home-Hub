"""kiosk mode: sessions.kiosk

Revision ID: 0006_session_kiosk
Revises: 0005_family_modules
"""
import sqlalchemy as sa
from alembic import op

revision = "0006_session_kiosk"
down_revision = "0005_family_modules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("kiosk", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("sessions", "kiosk")
