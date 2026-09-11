"""auth: users rework, sessions, audit_log

Revision ID: 0002_auth
Revises: 0001_initial
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_auth"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # dev users table predates real accounts; contents were sample family
    # rows only, so rebuild rather than migrate data.
    op.drop_table("users")
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("display_name", sa.String(80), nullable=False, server_default=""),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column("password_hash", sa.String(128), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ts", sa.DateTime(timezone=True), server_default=sa.func.now(), index=True),
        sa.Column("username", sa.String(64), nullable=False, server_default=""),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("sessions")
    op.drop_table("users")
    # original family users table is not restored
