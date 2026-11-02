# Third-party code (downloaded, not committed)

| Folder | Project | License | Version |
| --- | --- | --- | --- |
| `viridian/` | [Viridian](https://github.com/dylan7077/viridian) by Dylan Roberts | MIT (its `LICENSE` file is kept in the folder) | commit `f22ec116a727dc3d0976e304eb28ad83c89d681b` |

`scripts/grading-setup.ps1` (Windows) or `scripts/grading-setup.sh` (macOS / Linux) downloads it at
that commit. It's used, unchanged, by the optional pre-grading service in `services/grading/`.
Keep its copyright and permission notice if you redistribute any of its code. To move to a newer
commit, change the pin in both setup scripts, run the Python tests and a real photo check, and
update `docs/SOURCES.md`.
