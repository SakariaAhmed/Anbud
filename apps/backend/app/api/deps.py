from fastapi import Header


def get_tenant_id(x_tenant_id: str | None = Header(default=None)) -> str:
    return x_tenant_id or "default"


def get_actor(x_user_name: str | None = Header(default=None)) -> str:
    return x_user_name or "system"
