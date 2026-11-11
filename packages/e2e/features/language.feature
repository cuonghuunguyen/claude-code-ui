Feature: UI language (GH-510)

  Scenario: A Vietnamese browser with no saved choice opens in Vietnamese
    Given the viewport is 1440x900
    And the app is open
    And the browser language is "vi-VN"
    Then the app is in Vietnamese
    And I capture "vi browser default"

  Scenario: The language picker applies at once and the choice survives a reload
    Given the viewport is 1440x900
    And the app is open
    Then the app is in English
    When I mark the page
    And I choose the language "Tiếng Việt" in Settings
    Then the app is in Vietnamese
    And the page did not navigate
    And no text is clipped in the open dialog or the sidebar
    And I capture "picker vietnamese"
    When I reload the page
    Then the app is in Vietnamese
    When I choose the language "System" in Settings
    Then the app is in English
    And I capture "picker system"

  Scenario: Main views in English and Vietnamese, light and dark, then Vietnamese on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin
    And the scratch project has an uncommitted change
    And a Haiku session with one finished reply
    Given the mode is "light"
    When I open the Changes tab of the side panel
    And I switch the language to English
    Then the app is in English
    And I capture "session English light"
    When I open Settings
    Then no text is clipped in the open dialog or the sidebar
    And I capture "settings English light"
    When I close Settings
    And I open Focus
    Then I capture "focus English light"
    Given the mode is "dark"
    When I open the Changes tab of the side panel
    And I switch the language to English
    Then the app is in English
    And I capture "session English dark"
    When I open Settings
    Then no text is clipped in the open dialog or the sidebar
    And I capture "settings English dark"
    When I close Settings
    And I open Focus
    Then I capture "focus English dark"
    Given the mode is "light"
    When I open the Changes tab of the side panel
    And I switch the language to Vietnamese
    Then the app is in Vietnamese
    And I capture "session Vietnamese light"
    When I open Settings
    Then no text is clipped in the open dialog or the sidebar
    And I capture "settings Vietnamese light"
    When I close Settings
    And I open Focus
    Then I capture "focus Vietnamese light"
    Given the mode is "dark"
    When I open the Changes tab of the side panel
    And I switch the language to Vietnamese
    Then the app is in Vietnamese
    And I capture "session Vietnamese dark"
    When I open Settings
    Then no text is clipped in the open dialog or the sidebar
    And I capture "settings Vietnamese dark"
    When I close Settings
    And I open Focus
    Then I capture "focus Vietnamese dark"
    Given the viewport is 390x844
    Then the app is in Vietnamese
    And the page has no horizontal scroll
    And I capture "phone vi session"
    When I open Settings
    Then the page has no horizontal scroll
    And no text is clipped in the open dialog or the sidebar
    And I capture "phone vi settings"
