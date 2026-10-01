"""The supported roster must have executable, passing regression contracts."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from agent_team_backend.cli_vendors.registry import VENDORS
from .catalog import load_catalog, validate_catalog, validate_outcomes


def test_catalog_covers_the_supported_contracts():
    assert validate_catalog(load_catalog(), VENDORS) == []


@pytest.mark.parametrize("damage", ["vendor", "case", "fixture"])
def test_missing_coverage_is_rejected(damage):
    data = deepcopy(load_catalog())
    if damage == "vendor":
        del data["vendors"]["claude"]
    elif damage == "case":
        del data["vendors"]["claude"]["cases"]["reader"]
    else:
        data["vendors"]["claude"]["fixture"] = "missing.json"
    assert validate_catalog(data, VENDORS)


@pytest.mark.parametrize("outcome", ["skipped", "xfailed", "not-run"])
def test_a_nonpassing_case_cannot_satisfy_coverage(outcome):
    assert validate_outcomes({"case-a"}, {"case-a": outcome})
    assert validate_outcomes({"case-a"}, {"case-a": "passed"}) == []


@pytest.mark.parametrize("damage", ["schema", "platform"])
def test_an_unknown_schema_or_platform_cannot_silently_exempt_coverage(damage):
    data = deepcopy(load_catalog())
    if damage == "schema":
        data["schemaVersion"] = 99
    else:
        data["vendors"]["claude"]["cases"]["reader"]["requires"] = ["posxi_pty"]
    assert validate_catalog(data, VENDORS)


def test_deleted_or_renamed_collected_cases_are_rejected():
    from .catalog import validate_collection
    assert validate_collection({"tests/test_contract.py::test_reader"}, {"tests/test_contract.py::test_renamed"})
    assert validate_collection({"tests/test_contract.py::test_reader"}, {"tests/test_contract.py::test_reader[claude]"}) == []


def test_full_collection_validates_before_sharding_and_audits_only_selected_cases():
    from . import catalog

    class Item:
        def __init__(self, nodeid):
            self.nodeid = nodeid
            self.user_properties = []
            self.markers = []

        def add_marker(self, marker):
            self.markers.append(marker.name)

    required = catalog._required_cases() | catalog._historical_cases()
    items = [Item(nodeid) for nodeid in sorted(required)]
    config = SimpleNamespace(args=[str(catalog.ROOT / "backend" / "tests")])
    catalog.pytest_collection_modifyitems(config, items)
    assert all("cli_regression" in item.markers for item in items)
    owners = catalog._historical_case_owners()
    vendor_cases = catalog._required_cases()
    for item in items:
        expected_shared = owners.get(item.nodeid) == "shared"
        expected_vendor = item.nodeid in vendor_cases or owners.get(item.nodeid) not in {None, "shared"}
        assert ("cli_shared" in item.markers) == expected_shared
        assert ("cli_vendor" in item.markers) == expected_vendor
    assert any("cli_shared" in item.markers for item in items)
    assert any("cli_vendor" in item.markers for item in items)
    # pytest -m and the deterministic shard plugin run after tryfirst marking.
    selected = items[::2]
    catalog.pytest_collection_finish(SimpleNamespace(config=config, items=selected))
    assert config._cli_contract_selected == {item.nodeid for item in selected}
    with pytest.raises(pytest.UsageError, match="required case was not collected"):
        catalog.pytest_collection_modifyitems(config, items[1:])


def test_focused_collection_does_not_require_unselected_vendor_cases():
    from . import catalog
    config = SimpleNamespace(args=["tests/cli_regression/test_catalog.py"])
    catalog.pytest_collection_modifyitems(config, [])
    catalog.pytest_collection_finish(SimpleNamespace(config=config, items=[]))
    assert config._cli_contract_selected == set()


@pytest.mark.parametrize("requirements", [["posix_pty", "windows_conpty"], ["darwin_helper", "windows_conpty"]])
def test_no_case_can_be_exempt_on_every_ci_platform(requirements):
    data = deepcopy(load_catalog())
    data["vendors"]["claude"]["cases"]["reader"]["requires"] = requirements
    assert any("no CI runner" in error for error in validate_catalog(data, VENDORS))


def test_a_supported_reader_cannot_be_exempted_on_another_supported_os():
    data = deepcopy(load_catalog())
    data["vendors"]["claude"]["cases"]["reader"]["requires"] = ["posix_pty"]
    assert any("platform exemptions" in error for error in validate_catalog(data, VENDORS))


def test_droid_session_fixtures_are_exempt_only_on_windows(monkeypatch):
    from . import catalog

    data = load_catalog()["vendors"]["droid"]["cases"]
    monkeypatch.setattr(catalog.sys, "platform", "win32")
    required = catalog._required_cases()
    assert data["reader"]["nodeid"] not in required
    assert data["resume"]["nodeid"] not in required
    assert data["launch"]["nodeid"] in required
    assert load_catalog()["vendors"]["claude"]["cases"]["reader"]["nodeid"] in required

    monkeypatch.setattr(catalog.sys, "platform", "linux")
    required = catalog._required_cases()
    assert data["reader"]["nodeid"] in required
    assert data["resume"]["nodeid"] in required


def test_droid_launch_cannot_inherit_the_session_platform_exemption():
    data = deepcopy(load_catalog())
    data["vendors"]["droid"]["cases"]["launch"]["requires"] = ["posix_pty"]
    assert any("platform exemptions" in error for error in validate_catalog(data, VENDORS))
