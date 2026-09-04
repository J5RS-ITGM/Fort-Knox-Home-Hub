"""alarm pin: users.pin_hash

Revision ID: 0004_alarm_pin
Revises: 0003_config
"""
import sqlalchemy as sa
from alembic import op

revision = "0004_alarm_pin"
down_revision = "0003_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pin_hash", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "pin_hash")
