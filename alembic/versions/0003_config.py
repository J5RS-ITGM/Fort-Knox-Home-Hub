"""config: service_allowlist + app_settings

Revision ID: 0003_config
Revises: 0002_auth
"""
import sqlalchemy as sa
from alembic import op

revision = "0003_config"
down_revision = "0002_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "service_allowlist",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("domain", sa.String(48), nullable=False),
        sa.Column("service", sa.String(64), nullable=False),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.UniqueConstraint("domain", "service", name="uq_allow_domain_service"),
    )
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


    op.create_table(
        "family_members",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("emoji", sa.String(16), nullable=False, server_default="🙂"),
        sa.Column("color", sa.String(16), nullable=False, server_default="#6b8afd"),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("family_members")
    op.drop_table("app_settings")
    op.drop_table("service_allowlist")
