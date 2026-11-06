# GH-578, ADR 0009. One Hub per machine: a Hub attaches to the Hub of a Side machine instead of running a second process there. Same throwaway sshd and
# run-local ssh config as ssh-side.feature (the owner's ~/.ssh is never read or written). Every scenario starts from an installed host with no Hub
# (it ends the Hubs of the host first; the first scenario installs claude-ui there). The host has no Claude login, so no turn runs there.
# Docker: sides-auto-return.feature "A killed bridge ..." (fake docker). WSL is a manual check on Windows. Skips itself on Windows.
Feature: One Hub per machine

  Scenario: An SSH host with a Hub the user started is attached to, and its own Hub sees the project
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I stop the app, replace the Hub of the SSH host by one the user started and start the app
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And one Hub runs in the SSH host
    And the Hub of the SSH host was started by "the user"
    When I close Settings
    And I open Open project on the last chosen host
    And I open the remote project folder
    And I send the prompt "hello" in the remote project
    Then the session says Claude is not logged in
    And one Hub runs in the SSH host
    And the Hub of the SSH host lists the remote project itself
    And I capture "user-hub-attached"

  Scenario: An SSH host without a Hub gets one started by the attach, which ends by its Grace period
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And one Hub runs in the SSH host
    And the Hub of the SSH host was started by "an attach"
    And I capture "attach-started-hub"
    When I set the Grace period of the SSH host "e2e-ok" to "1"
    And I stop the app
    Then no Hub runs in the SSH host within 180 seconds
    When I start the app
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Grace period ran out"
    # the Grace period is a shared setting: leave the default for the next scenarios
    When I set the Grace period of the SSH host "e2e-ok" to "30"
    And I capture "hub-ended-by-grace"

  Scenario: A Hub of an incompatible version shows both versions and Update, which updates it and attaches again
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When the claude-ui installed in the SSH host says it is version "1.1.0"
    And I stop the app, replace the Hub of the SSH host by one started by an attach with the schema "0,0" and start the app
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Claude UI 1.1.0 there, dev here"
    And the Settings row of the SSH host "e2e-ok" shows the Update button
    And the page has no horizontal scroll
    And the Settings row of the SSH host "e2e-ok" fits the viewport
    And I capture "mismatch-row-1440"
    When the viewport becomes 390x844
    Then the Settings row of the SSH host "e2e-ok" shows the Update button
    And the page has no horizontal scroll
    And the Settings row of the SSH host "e2e-ok" fits the viewport
    And I capture "mismatch-row-390"
    When the viewport becomes 1440x900
    And I click Update on the Settings row of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And one Hub runs in the SSH host
    And the Hub of the SSH host runs the schema "1,1"
    And the Hub of the SSH host was started by "an attach"
    And I capture "mismatch-updated"

  Scenario: Two Claude UIs attach to the Hub of one SSH host and both stay Running
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When a second Claude UI opens the SSH host "e2e-ok"
    And I wait 60 seconds
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the second Claude UI shows the SSH host "e2e-ok" as "Running"
    And one Hub runs in the SSH host
    And I capture "first-claude-ui-running"
    And I capture the second Claude UI as "second-claude-ui-running"

  Scenario: A Claude UI the user starts in the SSH host retires the Hub the attach started, and the attached Hub follows it
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the Hub of the SSH host was started by "an attach"
    When I watch the Settings row of the SSH host "e2e-ok"
    And the user starts claude-ui in the SSH host
    Then the Settings row of the SSH host "e2e-ok" went from Reconnecting to Running by itself
    And one Hub runs in the SSH host
    And the Hub of the SSH host is the one the user started
    And the Hub of the SSH host was started by "the user"
    And the user's claude-ui in the SSH host printed no waiting line
    And I capture "user-start-retired-attach-hub"

  # GH-619: the attach does not need this build in the host: a live Hub whose frame schema overlaps is bridged through its own cli.
  Scenario: An SSH host with a schema-compatible Hub of another build is attached without installing this build
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I stop the app, move this build out of the SSH host and start the Hub the user started from there and start the app
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And one Hub runs in the SSH host
    And the Hub of the SSH host was started by "the user"
    And the claude-ui folder of this build does not exist in the SSH host
    And I capture "compatible-hub-no-install"
    When I kill the Hub's ssh process of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And one Hub runs in the SSH host
    And the claude-ui folder of this build does not exist in the SSH host
    And I capture "compatible-hub-reattached"

  Scenario: Open project on an SSH host with a schema-compatible Hub of another build offers no Install
    Given a throwaway SSH host
    When I end every Hub of the SSH host
    And I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I stop the app, move this build out of the SSH host and start the Hub the user started from there and start the app
    And I watch for the Install and Update buttons
    And I open the app and Settings › Sides
    And I close Settings
    And I open Open project on the last chosen host
    Then the folder browser of Open project shows
    And the side panel never showed an Install or Update button
    And the claude-ui folder of this build does not exist in the SSH host
    And the page has no horizontal scroll
    And I capture "compatible-hub-check-desktop"
    When the viewport becomes 390x844
    Then the page has no horizontal scroll
    And the side panel never showed an Install or Update button
    And I capture "compatible-hub-check-phone"
