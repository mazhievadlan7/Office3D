"""`python -m speech_gateway` — run the gateway on 127.0.0.1 (see config.py)."""

from __future__ import annotations

import logging
import sys
import warnings


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    # Silero's packaged code has a harmless invalid-escape warning.
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    import uvicorn

    from .app import create_app
    from .config import Settings

    settings = Settings.from_env()
    settings.check_bind()
    settings.home.mkdir(parents=True, exist_ok=True)
    settings.use_hf_home()
    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", proxy_headers=False)


if __name__ == "__main__":
    main()
