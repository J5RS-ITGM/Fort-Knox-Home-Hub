"""tasks: multi-assignee + reminders + per-member completions

Revision ID: 0010_tasks_reminders
Revises: 0009_recipes_todos
"""
import sqlalchemy as sa
from alembic import op

revision = "0010_tasks_reminders"
down_revision = "0009_recipes_todos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # chores -> tasks semantics: a task can belong to several family members
    # (assignee_ids CSV), and can be a reminder (remind_time HH:MM local +
    # repeat_days: "daily" | "weekdays" | "custom:0,2,4" JS weekday ints).
    with op.batch_alter_table("chores") as b:
        b.add_column(sa.Column("assignee_ids", sa.Text(), nullable=False, server_default=""))
        b.add_column(sa.Column("remind_time", sa.String(5), nullable=True))
        b.add_column(sa.Column("repeat_days", sa.String(30), nullable=False, server_default="daily"))
    # existing single assignee becomes the first (only) entry
    op.execute("UPDATE chores SET assignee_ids = member_id WHERE assignee_ids = ''")

    # completions become per-member: (chore, date, member). Legacy rows keep
    # member_id NULL and count as "whole task done" for that date.
    with op.batch_alter_table("chore_completions") as b:
        b.add_column(sa.Column("member_id", sa.String(36), nullable=True))
        b.drop_constraint("uq_chore_date", type_="unique")
        b.create_unique_constraint("uq_chore_date_member", ["chore_id", "date", "member_id"])


def downgrade() -> None:
    with op.batch_alter_table("chore_completions") as b:
        b.drop_constraint("uq_chore_date_member", type_="unique")
        b.create_unique_constraint("uq_chore_date", ["chore_id", "date"])
        b.drop_column("member_id")
    with op.batch_alter_table("chores") as b:
        b.drop_column("repeat_days")
        b.drop_column("remind_time")
        b.drop_column("assignee_ids")
