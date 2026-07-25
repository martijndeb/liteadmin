import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent


def test_debian_control_template_ends_with_newline():
    control = ROOT / "packaging" / "control"
    assert control.exists()
    assert control.read_bytes().endswith(b"\n")


def test_every_plugin_has_a_control_file():
    """A plugin without packaging metadata is silently skipped by the release
    workflow, so it would never reach the apt repo."""
    for plugin in sorted((ROOT / "src" / "plugins").iterdir()):
        if plugin.is_dir():
            assert (ROOT / "packaging" / plugin.name / "control").exists(), plugin.name


@pytest.mark.skipif(shutil.which("dpkg-deb") is None, reason="dpkg-deb not available")
def test_packages_build_and_verify(tmp_path):
    """Build every .deb the release workflow builds and run the same content,
    mode and integrity checks on them."""
    def run(*args):
        return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=False)

    version = "0.0.0-test"
    built = [run("sh", "packaging/build-core.sh", version, str(tmp_path))]
    for plugin in sorted((ROOT / "src" / "plugins").iterdir()):
        if plugin.is_dir():
            built.append(run("sh", "packaging/build-plugin.sh", plugin.name, version, str(tmp_path)))
    for result in built:
        assert result.returncode == 0, result.stderr

    debs = sorted(str(p) for p in tmp_path.glob("*.deb"))
    assert len(debs) == 1 + len([p for p in (ROOT / "src" / "plugins").iterdir() if p.is_dir()])

    verified = run("sh", "packaging/verify-deb.sh", *debs)
    assert verified.returncode == 0, verified.stdout + verified.stderr
