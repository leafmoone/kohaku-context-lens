from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from kohakuterrarium.api.deps import get_service, resolve_request_session_dir
from kohakuterrarium.terrarium import TerrariumService

from .models import Analysis, HandoffResult, Targets
from .sessions import (
    InvalidTarget,
    RemoteLiveUnsupported,
    TargetNotFound,
    analyze_live,
    analyze_saved,
    handoff_live,
    handoff_saved,
    list_targets,
)

router = APIRouter()
Service = Annotated[TerrariumService, Depends(get_service)]
SessionDir = Annotated[Path, Depends(resolve_request_session_dir)]
TargetQuery = Annotated[str | None, Query()]


@router.get("/targets")
async def targets(service: Service, session_dir: SessionDir) -> Targets:
    return await list_targets(service, session_dir)


@router.get("/analysis")
async def analysis(
    service: Service,
    session_dir: SessionDir,
    session_id: TargetQuery = None,
    creature_id: TargetQuery = None,
    saved_name: TargetQuery = None,
    agent: TargetQuery = None,
) -> Analysis:
    return await project_target(
        service,
        session_dir,
        session_id,
        creature_id,
        saved_name,
        agent,
        analyze_live,
        analyze_saved,
    )


@router.get("/handoff")
async def handoff(
    service: Service,
    session_dir: SessionDir,
    session_id: TargetQuery = None,
    creature_id: TargetQuery = None,
    saved_name: TargetQuery = None,
    agent: TargetQuery = None,
) -> HandoffResult:
    return await project_target(
        service,
        session_dir,
        session_id,
        creature_id,
        saved_name,
        agent,
        handoff_live,
        handoff_saved,
    )


async def project_target[T](
    service: TerrariumService,
    session_dir: Path,
    session_id: str | None,
    creature_id: str | None,
    saved_name: str | None,
    agent: str | None,
    live: Callable[[TerrariumService, str, str | None], Awaitable[T]],
    saved: Callable[[TerrariumService, Path, str, str | None], Awaitable[T]],
) -> T:
    try:
        if session_id and saved_name is None and agent is None:
            return await live(service, session_id, creature_id)
        if saved_name is not None and session_id is None and creature_id is None:
            return await saved(service, session_dir, saved_name, agent)
        raise InvalidTarget(
            "Provide session_id with optional creature_id, or saved_name with optional agent"
        )
    except InvalidTarget as exc:
        raise HTTPException(400, detail=str(exc)) from exc
    except (TargetNotFound, FileNotFoundError) as exc:
        detail = (
            str(exc) if isinstance(exc, TargetNotFound) else "Session file not found"
        )
        raise HTTPException(404, detail=detail) from exc
    except RemoteLiveUnsupported as exc:
        raise HTTPException(501, detail=str(exc)) from exc
