# Written for GH-448, not run in that release. Needs a POSIX host, `dist/side` (npm run build) and, for the first scenario, `npm pack`
# of the package (the npm fallback path); the fake docker CLI (support/fake-docker.ts) replaces Docker. The daemon's part cache is
# <run>/cache (XDG_CACHE_HOME), never the owner's ~/.cache. Skips itself on Windows.
Feature: Docker side bundle fallback texts and guide row

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
