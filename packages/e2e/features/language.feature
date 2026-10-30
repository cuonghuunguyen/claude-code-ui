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

  Scenario Outline: Main views in <lang>, <mode>
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin
    And the scratch project has an uncommitted change
    And a Haiku session with one finished reply
    And the mode is "<mode>"
    When I open the Changes tab of the side panel
    And I switch the language to <lang>
    Then the app is in <lang>
    And I capture "session <lang> <mode>"
    When I open Settings
    Then no text is clipped in the open dialog or the sidebar
    And I capture "settings <lang> <mode>"
    When I close Settings
    And I open Focus
    Then I capture "focus <lang> <mode>"

    Examples:
      | lang       | mode  |
      | English    | light |
      | English    | dark  |
      | Vietnamese | light |
      | Vietnamese | dark  |

  Scenario: Vietnamese fits a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I switch the language to Vietnamese
    Then the page has no horizontal scroll
    And I capture "phone vi session"
    When I open Settings
    Then the page has no horizontal scroll
    And no text is clipped in the open dialog or the sidebar
    And I capture "phone vi settings"
