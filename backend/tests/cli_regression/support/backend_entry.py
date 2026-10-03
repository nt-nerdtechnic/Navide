"""Disposable process entry: guards first, then the real backend main."""
from pathlib import Path
import os

from tests.cli_regression.support.isolation import install_external_guards

install_external_guards(Path(os.environ["NAVIDE_REGRESSION_ROOT"]))

from agent_team_backend.__main__ import main

raise SystemExit(main())
