"""recipes + todos

Revision ID: 0009_recipes_todos
Revises: 0008_google_id
"""
import sqlalchemy as sa
from alembic import op

revision = "0009_recipes_todos"
down_revision = "0008_google_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("category", sa.String(40), nullable=False, server_default=""),
        sa.Column("servings", sa.String(40), nullable=False, server_default=""),
        sa.Column("prep_time", sa.String(40), nullable=False, server_default=""),
        sa.Column("ingredients", sa.Text(), nullable=False, server_default=""),
        sa.Column("steps", sa.Text(), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "todos",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("member_id", sa.String(36), sa.ForeignKey("family_members.id", ondelete="SET NULL"), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("todos")
    op.drop_table("recipes")
