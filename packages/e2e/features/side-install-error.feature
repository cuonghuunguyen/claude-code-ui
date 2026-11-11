# Written for GH-448, not run in that release. Needs a POSIX host, `dist/side` (npm run build) and, for the first scenario, `npm pack`
# of the package (the npm fallback path); the fake docker CLI (support/fake-docker.ts) replaces Docker. The daemon's part cache is
# <run>/cache (XDG_CACHE_HOME), never the owner's ~/.cache. Skips itself on Windows.
# GH-617, GH-618. A failed install of a side shows one summary line in the sidebar (npm output behind Details) and, in Open project, one primary
# "Retry install" with "Check again" (none while it checks). The failing install is a fake docker CLI (support/fake-docker.ts) whose setup
# script answers `CLAUDE_UI_SETUP install_failed <npm text>`; SSH uses the same UI path. POSIX only, skips itself on Windows.
Feature: Docker side bundle fallback texts, guide row and a failed side install shows one error and one way out

  Scenario: A container whose probe fails names the probe in the npm fallback reason
    Given a fake Docker container "probe-dev" whose target probe fails with "OCI runtime exec failed"
    When I open the Docker container "probe-dev" from Open project
    And I click Install in the side panel
    Then the side panel says the install uses npm because the container did not answer the target probe
    And I capture "docker-probe-fallback"

  Scenario: A cold part cache shows the bundle row with the download note
    Given a fake Docker container "cold-dev" on x86_64 glibc 2.36 with an empty part cache
    When I open the Docker container "cold-dev" from Open project
    Then the container row says the bundle needs the host to download the parts
    And I capture "docker-bundle-download-row"

  Scenario: The bundle row fits a phone
    Given the viewport is 390x844
    And a fake Docker container "phone-dev" on x86_64 glibc 2.36 with an empty part cache
    When I open the Docker container "phone-dev" from Open project
    Then the container row says the bundle needs the host to download the parts
    And the page has no horizontal scroll
    And I capture "docker-bundle-download-row-phone"

  Scenario Outline: Two projects of a side whose install failed share one status line, which keeps its open Details until Retry, and Details stay open after Retry
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
    When I wait 36 seconds without a click
    Then the sidebar status never showed Starting and the Details are open
    And I capture "sidebar-after-wait"
    When I press Retry in the sidebar status
    Then the error is back with the Details open after the Retry
    And the page has no horizontal scroll
    And I capture "sidebar-after-retry"

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
