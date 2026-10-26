from __future__ import annotations

import argparse
import getpass
import sys

from .config import load_settings
from .users import AccountOperationError, LocalAccountStore


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage POI Dashboard account roles")
    subcommands = parser.add_subparsers(dest="command", required=True)
    role = subcommands.add_parser("set-role", help="assign or revoke Super Admin")
    role.add_argument("user_id", help="stable internal account ID from the users database")
    role.add_argument("role", choices=("user", "super_admin"))
    role.add_argument(
        "--confirm",
        help="non-interactive confirmation; must exactly match '<user-id>:<role>'",
    )
    args = parser.parse_args()

    settings = load_settings()
    store = LocalAccountStore(settings["auth"]["users_db_path"])
    account = store.get(args.user_id)
    if account is None:
        print("Account not found", file=sys.stderr)
        return 2
    print(
        f"Account: {account['username']} ({account['email'] or 'no email'})\n"
        f"Current role: {account['role']}\nRequested role: {args.role}"
    )
    expected = f"{args.user_id}:{args.role}"
    confirmation = args.confirm or input(f"Type {expected!r} to confirm: ").strip()
    if confirmation != expected:
        print("Confirmation did not match; no change made", file=sys.stderr)
        return 2
    try:
        updated = store.set_role(
            args.user_id, args.role, actor_id=f"operator:{getpass.getuser()}"
        )
    except AccountOperationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"Role updated: {updated['id']} is now {updated['role']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
