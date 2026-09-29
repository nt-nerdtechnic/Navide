"""Negative controls for the historical regression gate itself."""

from __future__ import annotations

from copy import deepcopy

import pytest

from tests.cli_regression.catalog import validate_outcomes
from tests.cli_regression.historical_catalog import (
    all_case_nodeids,
    load_catalog,
    matches_nodeid,
    platform_capabilities,
    required_cases,
    validate_catalog,
)

pytestmark = pytest.mark.cli_regression

_CASE = "tests/test_example.py::test_contract"


@pytest.fixture
def catalog():
    data = deepcopy(load_catalog())
    data["regressions"] = data["regressions"][:1]
    data["regressions"][0]["cases"] = [{"nodeid": _CASE, "requires": []}]
    return data


def test_committed_catalog_has_valid_metadata_without_git_history():
    assert validate_catalog(load_catalog()) == []


@pytest.mark.parametrize("reference", ["not-a-commit", "c0eff2e8; exit 0", "", "abc", "f" * 41])
def test_malformed_sha_reference_is_refused(catalog, reference):
    catalog["regressions"][0]["commits"] = [reference]
    assert any("SHA references" in error for error in validate_catalog(catalog))


def test_unknown_vendor_owner_is_refused(catalog):
    catalog["regressions"][0]["owner"] = "new-unregistered-cli"
    assert any("unknown owner" in error for error in validate_catalog(catalog))


def test_missing_actual_collected_case_is_refused(catalog):
    errors = validate_catalog(catalog, ["tests/test_example.py::test_other"])
    assert errors == [f"historical catalog shared.tty-signal-inheritance: required case not collected: {_CASE}"]


def test_a_filename_without_a_collected_test_is_not_coverage(catalog):
    catalog["regressions"][0]["cases"][0]["nodeid"] = "tests/test_example.py"
    assert any("invalid backend test nodeid" in error for error in validate_catalog(catalog))


def test_base_nodeid_matches_real_parametrized_collection(catalog):
    assert validate_catalog(catalog, [_CASE + "[first]", _CASE + "[second]"]) == []
    assert matches_nodeid(_CASE, _CASE + "[first]")
    assert not matches_nodeid(_CASE, _CASE + "_unrelated")
    assert not matches_nodeid(_CASE + "[first]", _CASE + "[second]")


def test_active_entry_cannot_have_zero_cases(catalog):
    catalog["regressions"][0]["cases"] = []
    assert any("no executable cases" in error for error in validate_catalog(catalog))


def test_source_only_assertions_cannot_qualify_as_behavioral_evidence(catalog):
    catalog["regressions"][0]["provenance"]["kind"] = "source-history"
    assert any("source-only evidence" in error for error in validate_catalog(catalog))


def test_duplicate_reference_cannot_claim_two_historical_guarantees(catalog):
    duplicate = deepcopy(catalog["regressions"][0])
    duplicate["id"] = "shared.another-claim"
    catalog["regressions"].append(duplicate)
    assert any("duplicate case reference" in error for error in validate_catalog(catalog))


@pytest.mark.parametrize("requirements", [["has-provider-key"], ["posix_pty", "windows_conpty"], None])
def test_unknown_or_impossible_capability_exclusion_is_refused(catalog, requirements):
    catalog["regressions"][0]["cases"][0]["requires"] = requirements
    assert any("capabilit" in error for error in validate_catalog(catalog))


def test_only_declared_platform_capability_allows_noncollection(catalog):
    catalog["regressions"][0]["cases"][0]["requires"] = ["windows_conpty"]
    assert validate_catalog(catalog, [], platform="linux") == []
    assert validate_catalog(catalog, [], platform="win32")
    assert required_cases(catalog, "linux") == {}
    assert required_cases(catalog, "win32") == {_CASE: "shared.tty-signal-inheritance"}
    assert all_case_nodeids(catalog) == {_CASE}
    assert platform_capabilities("darwin") == {"posix_pty"}


@pytest.mark.parametrize("outcome", ["skipped", "xfail", "failed", "not executed"])
def test_selected_applicable_case_must_actually_pass(catalog, outcome):
    outcomes = {} if outcome == "not executed" else {_CASE: outcome}
    errors = validate_outcomes(set(required_cases(catalog)), outcomes)
    assert len(errors) == 1
    assert _CASE in errors[0]


def test_capability_exclusion_does_not_hide_a_skip_on_the_native_runner(catalog):
    catalog["regressions"][0]["cases"][0]["requires"] = ["windows_conpty"]
    outcomes = {_CASE: "skipped"}
    assert validate_outcomes(set(required_cases(catalog, "linux")), outcomes) == []
    assert validate_outcomes(set(required_cases(catalog, "win32")), outcomes)


def test_focused_run_only_requires_its_selected_cases(catalog):
    assert validate_outcomes(set(), {}) == []
    assert validate_outcomes(set(required_cases(catalog)), {_CASE: "passed"}) == []


def test_superseded_history_is_documented_but_not_executed(catalog):
    entry = catalog["regressions"][0]
    entry.update(status="superseded", cases=[], superseded_by="d7ce6e31")
    assert validate_catalog(catalog, []) == []
    assert all_case_nodeids(catalog) == set()
    assert required_cases(catalog) == {}
    entry["cases"] = [{"nodeid": _CASE, "requires": []}]
    assert any("non-executable evidence" in error for error in validate_catalog(catalog))
