"""family modules: chores, chore_completions, calendar_events, photos

Revision ID: 0005_family_modules
Revises: 0004_alarm_pin
"""
import sqlalchemy as sa
from alembic import op

revision = "0005_family_modules"
down_revision = "0004_alarm_pin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chores",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("emoji", sa.String(16), nullable=False, server_default="⭐"),
        sa.Column("points", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("member_id", sa.String(36), sa.ForeignKey("family_members.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "chore_completions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("chore_id", sa.String(36), sa.ForeignKey("chores.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.String(10), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("chore_id", "date", name="uq_chore_date"),
    )
    op.create_table(
        "calendar_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("date", sa.String(10), nullable=False, index=True),
        sa.Column("time", sa.String(5), nullable=True),
        sa.Column("member_id", sa.String(36), sa.ForeignKey("family_members.id", ondelete="SET NULL"), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "photos",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("filename", sa.String(200), nullable=False),
        sa.Column("original", sa.String(200), nullable=False, server_default=""),
        sa.Column("content_type", sa.String(64), nullable=False, server_default="image/jpeg"),
        sa.Column("uploaded_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("photos")
    op.drop_table("calendar_events")
    op.drop_table("chore_completions")
    op.drop_table("chores")
