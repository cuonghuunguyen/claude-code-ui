Feature: The Changes file list compacts single-child folders and has a flat list view

  Background:
    Given the scratch project is a git repository with uncommitted files deep in single-child folders

  Scenario: Single-child folders show as one row; the list view shows paths and is kept after a reload
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes list rows are "a/b/c/d, x.ts, y.ts, z.md"
    And I capture "compact-folders"
    When I switch the Changes list view
    Then the Changes list rows are "a/b/c/d/x.ts, a/b/c/d/y.ts, z.md"
    And I capture "list-view"
    When I reload the page
    And I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes list rows are "a/b/c/d/x.ts, a/b/c/d/y.ts, z.md"
    When I switch the Changes list view
    Then the Changes list rows are "a/b/c/d, x.ts, y.ts, z.md"
