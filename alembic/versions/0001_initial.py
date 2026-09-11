"""initial tables: users, sensor_placements, panel_layouts

Revision ID: 0001
Revises:
Create Date: 2026-08-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("role", sa.String(16), nullable=False, server_default="child"),
        sa.Column("pin_hash", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "sensor_placements",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entity_id", sa.String(120), nullable=False),
        sa.Column("room", sa.String(80), nullable=False, server_default=""),
        sa.Column("floor", sa.Integer, nullable=False, server_default="1"),
        sa.Column("x", sa.Float, nullable=False, server_default="0"),
        sa.Column("y", sa.Float, nullable=False, server_default="0"),
        sa.Column("icon", sa.String(64), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("entity_id", name="uq_placement_entity"),
    )
    op.create_index("ix_sensor_placements_entity_id", "sensor_placements", ["entity_id"])
    op.create_table(
        "panel_layouts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("panel_key", sa.String(64), nullable=False),
        sa.Column("layout_json", sa.Text, nullable=False, server_default="{}"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "panel_key", name="uq_layout_user_panel"),
    )


def downgrade() -> None:
    op.drop_table("panel_layouts")
    op.drop_index("ix_sensor_placements_entity_id", table_name="sensor_placements")
    op.drop_table("sensor_placements")
    op.drop_table("users")
