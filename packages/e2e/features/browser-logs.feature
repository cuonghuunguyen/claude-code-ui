Feature: Browser logs are kept in this browser and exported from Settings (browser-logs)

  Scenario: Logs survive a reload, include window errors and rejections with stack, and hold no pairing token
    Given the viewport is 1440x900
    And the app is open
    When the page logs an error, a window error and an unhandled rejection
    And I reload the page
    And I open Settings › About
    Then Browser logs shows entries
    When I export browser logs
    Then the browser logs file is named claude-ui-browser-logs-<date>.log
    And the browser logs file has the console error, the window error and the rejection
    And the window error and the rejection in the browser logs file have a stack
    And the browser logs file holds no pairing token
    And I capture "browser logs after reload"

  Scenario: Clear asks first, Keep browser logs off stops capture and it fits desktop and phone
    Given the viewport is 1440x900
    And the app is open
    When the page logs an error, a window error and an unhandled rejection
    And I open Settings › About
    And I click Clear browser logs
    Then Browser logs asks to confirm
    When I cancel clearing browser logs
    Then Browser logs shows entries
    When I click Clear browser logs
    And I confirm clearing browser logs
    Then Browser logs says there are no entries
    When I turn Keep browser logs off
    And the page logs an error
    Then Browser logs says nothing is kept
    When I turn Keep browser logs on
    Then Browser logs says there are no entries
    When the page logs an error
    And I reopen Settings › About
    Then Browser logs shows entries
    And I capture "browser logs desktop"
    Given the viewport is 390x844
    Then Browser logs is visible
    And the browser logs buttons are at least 44 px tall
    And the page has no horizontal scroll
    And I capture "browser logs phone"

  Scenario: The app works and the section says so when storage is blocked
    Given browser storage is blocked
    And the viewport is 1440x900
    And the app is open
    When the page logs an error
    And I open Settings › About
    Then Browser logs says it is unavailable
    And Export browser logs and Clear browser logs are disabled
    And I capture "browser logs unavailable"
