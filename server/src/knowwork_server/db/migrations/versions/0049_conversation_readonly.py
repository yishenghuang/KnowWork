"""自动化对话的只读标记

Revision ID: 0049
Revises: 0048
Create Date: 2026-11-11 12:10:00

自动化（定时任务）建的对话没有人看着，运行配置里只留只读工具（见 conversations/service.py 的 create，
readonly 一路传到 profile/compiler.py）。这个标记必须落库：宿主空闲回收会话、业务服务重启之后，
到点重开这段对话时仍要按只读编译，否则重开后就拿回了这个人自己的全部工具。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0049'
down_revision: str | None = '0048'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('conversation', sa.Column('readonly', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    op.drop_column('conversation', 'readonly')
