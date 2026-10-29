# GH-458, written and not run in that issue. A fake docker CLI (support/fake-docker.ts) runs a real side process; POSIX only, so it skips itself on
# Windows. Needs the source checkout (the side runs `main.ts --side` with tsx). The run's config and cache stay in <run>; the side's project is a
# tmp folder outside the daemon's roots. The bundle path (parts download) is covered by unit tests and the manual steps, not here.
Feature: Sides come back with the hub without manual steps

  Scenario: A killed side comes back without user action
    Given a fake Docker container "back-dev" that runs a claude-ui side with the project "back-proj"
    When I open the app
    Then the side "back-dev" is ready within 90 seconds
    When I kill the side process of "back-dev"
    Then the sidebar shows "Starting…" for the project "back-proj"
    And the side "back-dev" is ready within 30 seconds
    And I capture "side-restarted"

  Scenario: A stopped container is not restarted in a loop and starts when it runs again
    Given a fake Docker container "stop-dev" that runs a claude-ui side with the project "stop-proj"
    When I open the app
    Then the side "stop-dev" is ready within 90 seconds
    When the container "stop-dev" stops
    Then the side "stop-dev" was not started again for 20 seconds
    When the container "stop-dev" runs again
    Then the side "stop-dev" is ready within 60 seconds
    And I capture "container-back"

  Scenario: Start with Claude UI off keeps the side off at the next hub start
    Given a fake Docker container "pref-dev" that runs a claude-ui side with the project "pref-proj"
    When I open the app
    Then the side "pref-dev" is ready within 90 seconds
    When I turn "off" for "pref-dev" in Settings
    And I restart the daemon with the fake Docker
    Then the project "pref-proj" is not in the sidebar
    When I open Settings › Sides
    Then the Settings row of "pref-dev" says Start with Claude UI is "off"
    And I capture "settings-sides-off"
    When I turn "on" for "pref-dev" in Settings
    And I restart the daemon with the fake Docker
    Then the side "pref-dev" is ready within 90 seconds

  Scenario Outline: The Sides group fits the screen
    Given the viewport is <width>x<height>
    And a fake Docker container "view-dev" that runs a claude-ui side with the project "view-proj"
    When I open the app
    Then the side "view-dev" is ready within 90 seconds
    When I open Settings › Sides
    Then the page has no horizontal scroll
    And I capture "settings-sides"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A saved side's projects stay in the sidebar while it fails
    Given a fake Docker container "fail-dev" that runs a claude-ui side with the project "fail-proj"
    When I open the app
    Then the side "fail-dev" is ready within 90 seconds
    When the container "fail-dev" cannot start its side any more
    And I restart the daemon with the fake Docker
    Then the sidebar shows the project "fail-proj" of "fail-dev" as starting or failed
    And the sidebar shows the project "fail-proj" with a Retry action
    And I capture "side-failed-projects-stay"

  Scenario: The npm path: a side of an older build stays off and says it needs an update
    Given a fake Docker container "old-dev" saved by an older claude-ui whose bundle is not usable
    When I open the app
    Then the sidebar row of "older" says it needs an update with an Update action
    And the fake Docker log has no docker cp
    And I capture "needs-update"
