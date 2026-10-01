"""Member ratings: one 1-5 score per Navide Cloud member per extension.

`Extension.rating_sum` / `rating_count` are a cache of the member rows,
recomputed on every write, so the list/sort/API readers stay unchanged.
Anonymous ratings from before sign-in was required live only in
`legacy_rating_*` (migration 6) and never count.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Session, delete, select

from .models import Extension, ExtensionRating, Publisher

RATING_LIMIT_PER_HOUR = 20


class RatingError(ValueError):
    pass


def is_own_extension(session: Session, extension: Extension, member_id: str) -> bool:
    publisher = session.get(Publisher, extension.publisher_id)
    return publisher is not None and publisher.navide_member_id == member_id


def member_score(session: Session, extension: Extension, member_id: str) -> int | None:
    row = session.exec(
        select(ExtensionRating).where(
            ExtensionRating.extension_id == extension.id,
            ExtensionRating.member_id == member_id,
        )
    ).first()
    return row.score if row is not None else None


def _refresh_aggregate(session: Session, extension: Extension) -> None:
    total, count = session.exec(
        select(func.coalesce(func.sum(ExtensionRating.score), 0), func.count()).where(
            ExtensionRating.extension_id == extension.id
        )
    ).one()
    extension.rating_sum = int(total)
    extension.rating_count = int(count)
    session.add(extension)


def set_rating(session: Session, extension: Extension, member_id: str, score: int) -> None:
    """Create or replace this member's rating."""
    if not 1 <= score <= 5:
        raise RatingError("a rating is 1 to 5 stars")
    if is_own_extension(session, extension, member_id):
        raise RatingError("publishers cannot rate their own extensions")
    now = datetime.now(timezone.utc)
    statement = sqlite_insert(ExtensionRating).values(
        extension_id=extension.id, member_id=member_id, score=score, created_at=now, updated_at=now
    )
    statement = statement.on_conflict_do_update(
        index_elements=["extension_id", "member_id"], set_={"score": score, "updated_at": now}
    )
    session.execute(statement)
    _refresh_aggregate(session, extension)
    session.commit()


def remove_rating(session: Session, extension: Extension, member_id: str) -> None:
    session.execute(
        delete(ExtensionRating).where(
            ExtensionRating.extension_id == extension.id,
            ExtensionRating.member_id == member_id,
        )
    )
    _refresh_aggregate(session, extension)
    session.commit()
