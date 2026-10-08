"""One error shape for every API response: `{error: {code, message, fields?}}` (SPEC section 8)."""

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.permissions import Forbidden


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        fields: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.fields = fields


def _body(code: str, message: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return {"error": error}


_HTTP_CODES = {
    status.HTTP_401_UNAUTHORIZED: ("unauthenticated", "Please sign in."),
    status.HTTP_403_FORBIDDEN: ("forbidden", "You don't have permission to do that."),
    status.HTTP_404_NOT_FOUND: ("not_found", "Not found."),
    status.HTTP_405_METHOD_NOT_ALLOWED: ("method_not_allowed", "Method not allowed."),
}


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message, exc.fields), exc.status_code)

    @app.exception_handler(Forbidden)
    async def forbidden(_: Request, __: Forbidden) -> JSONResponse:
        code, message = _HTTP_CODES[status.HTTP_403_FORBIDDEN]
        return JSONResponse(_body(code, message), status.HTTP_403_FORBIDDEN)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        code, message = _HTTP_CODES.get(exc.status_code, ("error", str(exc.detail)))
        return JSONResponse(_body(code, message), exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields: dict[str, str] = {}
        for err in exc.errors():
            loc = [str(part) for part in err.get("loc", ()) if part not in ("body", "query")]
            fields.setdefault(".".join(loc) or "body", str(err.get("msg", "Invalid value")))
        return JSONResponse(
            _body("invalid", "Please check the highlighted fields.", fields),
            status.HTTP_422_UNPROCESSABLE_CONTENT,
        )
