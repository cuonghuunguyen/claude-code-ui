# GH-617, GH-618. A failed install of a side shows one summary line in the sidebar (npm output behind Details) and, in Open project, one primary
# "Retry install" with "Check again" (none while it checks). The failing install is a fake docker CLI (support/fake-docker.ts) whose setup
# script answers `CLAUDE_UI_SETUP install_failed <npm text>`; SSH uses the same UI path. POSIX only, skips itself on Windows.
Feature: A failed side install shows one error and one way out

  Scenario Outline: Two projects of a side whose install failed share one status line
    Given the viewport is <width>x<height>
    And a fake Docker container "fail-box" whose install fails, with the cached projects "alpha-proj" and "beta-proj"
    When I open the app
    And I press Update in the sidebar status of "alpha-proj"
    Then the sidebar shows one install failed summary with one Retry under "alpha-proj"
    And the sidebar has no side status under "beta-proj"
    When I open the Details of the sidebar status
    Then the Details show the npm text
    And the page has no horizontal scroll
    And I capture "sidebar-install-failed"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario Outline: A failed install in Open project offers one Retry install and Check again, none while it checks
    Given the viewport is <width>x<height>
    And a fake Docker container "fail-dev" whose install fails and whose check is slow
    When I open the Docker container "fail-dev" from Open project
    And I click Install in the side panel
    Then the side panel shows the install error with one primary "Retry install" and "Check again"
    And the page has no horizontal scroll
    And I capture "open-project-install-failed"
    When I press Check again in the side panel
    Then the side panel shows a spinner and no buttons
    And I capture "open-project-checking"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
