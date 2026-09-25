# Changelog

Notable changes to `@arsumbris/au-mcp-core`, newest first.

Release markers (`## 0.0.2-alpha`) group the changes that shipped in that arsumbris release.
Changes above the newest marker are not released yet.

## 0.0.2-alpha

### Added

- Five composition mutation tools over the engine's governed write path: `add_dep`,
  `remove_dep`, `add_workspace_member`, `remove_workspace_member`,
  `set_workspace_member_role`. Each authors `repo.yaml` / `workspace.yaml` as one commit.

### Changed

- The instance-count notice reads the engine's `instance_counts`.

## 0.0.1-alpha

The first public release.
