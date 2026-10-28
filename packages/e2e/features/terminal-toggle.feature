Feature: The side panel terminal toggle is quiet while the terminal shows

  Scenario Outline: The side panel header toggle has the quiet pressed style in the <theme> theme
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I switch to the <theme> theme
    And I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    And the side panel terminal toggle is pressed
    And the side panel terminal toggle is quiet like the titlebar one
    And I capture the side panel header as "<theme> header"

    Examples:
      | theme |
      | light |
      | dark  |
