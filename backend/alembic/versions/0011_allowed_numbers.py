"""allowed_numbers: VOIP phone allow-list for the wall panel

Revision ID: 0011_allowed_numbers
Revises: 0010_tasks_reminders
"""
import sqlalchemy as sa
from alembic import op

revision = "0011_allowed_numbers"
down_revision = "0010_tasks_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "allowed_numbers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("number", sa.String(20), nullable=False, unique=True),
        sa.Column("created_by", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("allowed_numbers")
