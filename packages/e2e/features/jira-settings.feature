Feature: Settings › Jira protects the token (GH-451)

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin

  Scenario: A non-local http address is refused, https and local http are accepted
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I open Settings › Jira
    And I set the Jira URL to "http://jira.example.com"
    Then the Jira URL shows an https error
    And I capture "http refused"
    When I set the Jira URL to "https://jira.example.com"
    Then the Jira URL shows no error
    When I set the Jira URL to "http://localhost:8080"
    Then the Jira URL shows no error
    When I set the Jira URL to the fake Jira
    Then the Jira URL shows no error
    And I capture "local http accepted"

  Scenario: The Jira URL error fits a phone screen
    Given the viewport is 390x844
    And a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I open Settings › Jira
    And I set the Jira URL to "http://jira.example.com"
    Then the Jira URL shows an https error
    And the page has no horizontal scroll
    And I capture "phone http refused"

  Scenario: A new Jira host clears the saved token
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I set up Jira in Settings with the fake Jira
    Then Jira reports it is connected as "Ann Example"
    When I set the Jira URL to the fake Jira on another host
    Then the Jira token is not set
    And I capture "token cleared by new host"
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the Ticket tab asks to set up Jira
    And I capture "ticket search off"

  Scenario: A new path on the same Jira host keeps the saved token
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I set up Jira in Settings with the fake Jira
    Then Jira reports it is connected as "Ann Example"
    When I set the Jira URL to the fake Jira with the path "/jira"
    Then the Jira token is set
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the ticket rows are "PRJ-1, PRJ-2"
    And I capture "token kept by new path"

  Scenario: An empty Jira URL clears the saved token
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I set up Jira in Settings with the fake Jira
    Then Jira reports it is connected as "Ann Example"
    When I set the Jira URL to ""
    Then the Jira token is not set
    And I capture "token cleared by empty url"

  Scenario: A token saved before the update is cleared and Settings says why
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And the daemon's saved Jira token has the old format without a host
    And I open the scratch project
    When I restart the daemon
    And I open Settings › Jira
    And I set the Jira URL to the fake Jira
    Then the Jira token is not set
    And Settings › Jira says the saved token was cleared by a security update
    And I capture "token reset notice"
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the Ticket tab asks to set up Jira
    When I close Settings
    And I open Settings › Jira
    And I save the Jira token "e2e-jira-token"
    Then the Jira token is set
    And Settings › Jira shows no token reset notice
    And I capture "token reset notice gone"
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the ticket rows are "PRJ-1, PRJ-2"
    And I capture "ticket search works after token saved"

  Scenario: A token saved before any URL binds to the first URL set in Settings
    Given a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And I open the scratch project
    When I open Settings › Jira
    And I set the Jira URL to ""
    And I save the Jira token "e2e-jira-token"
    And I set the Jira URL to the fake Jira
    Then the Jira token is set
    When I close Settings
    And I click the new worktree button of the scratch project
    And I open the "ticket" tab of the modal
    Then the ticket rows are "PRJ-1, PRJ-2"
    And I capture "token before url bound"

  Scenario: The token reset notice fits a phone screen
    Given the viewport is 390x844
    And a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3
    And the daemon's saved Jira token has the old format without a host
    And I open the scratch project
    When I restart the daemon
    And I open Settings › Jira
    And I set the Jira URL to the fake Jira
    And I open the Jira group again
    Then Settings › Jira says the saved token was cleared by a security update
    And the page has no horizontal scroll
    And I capture "phone token reset notice"
