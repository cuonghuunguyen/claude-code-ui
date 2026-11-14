Feature: Session skeleton while an existing session loads (GH-774)

  Scenario: Reloading a session tab shows the skeleton until its subscribe reply
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And subscribes can be held
    When the daemon holds session subscribes
    And I reload the page
    Then I capture "main-before"
    And the session skeleton shows in the main area
    And the main area does not ask to open or create a session
    And I note the skeleton boxes
    And I capture "main-skeleton"
    When the held subscribes are released
    Then the session pane replaced the skeleton in place
    And I capture "main-loaded"

  Scenario: Reload with several session tabs, the active one shows the skeleton
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    And subscribes can be held
    When the daemon holds session subscribes
    And I reload the page
    Then the session skeleton shows in the main area
    And the main area does not ask to open or create a session
    And I capture "tabs-skeleton"
    When the held subscribes are released
    Then the session pane replaced the skeleton in place

  Scenario: An aside popup shows the skeleton while it loads
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And subscribes can be held
    And I reload the page
    And the session pane replaced the skeleton in place
    When the daemon holds session subscribes
    And I ask the aside "Reply with the word two."
    Then I capture "aside-before"
    And the session skeleton shows in the aside popup
    And I capture "aside-skeleton"
    When the held subscribes are released
    Then the aside shows a reply
    And I capture "aside-loaded"

  Scenario: A split pane shows the skeleton for its loading session
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    And I click the second session tab
    And I split the two sessions one above the other
    And subscribes can be held
    When the daemon holds session subscribes
    And I reload the page
    Then the session skeleton shows in a split
    And I capture "split-skeleton"
    When the held subscribes are released
    Then both session splits are shown
    And I capture "split-loaded"

  Scenario: Phone layout shows the skeleton without a header
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    And subscribes can be held
    When the daemon holds session subscribes
    And I reload the page
    Then I capture "phone-before"
    And the session skeleton shows in the main area
    And the session skeleton has no header
    And the page has no horizontal scroll
    And I capture "phone-skeleton"
    When the held subscribes are released
    Then the session pane replaced the skeleton in place
    And I capture "phone-loaded"

  Scenario: Dark theme skeleton
    Given the viewport is 1440x900
    And the color scheme is dark
    And a Haiku session with one finished reply
    And subscribes can be held
    When the daemon holds session subscribes
    And I reload the page
    Then the session skeleton shows in the main area
    And I capture "dark-skeleton"
    When the held subscribes are released
    Then the session pane replaced the skeleton in place
