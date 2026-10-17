Feature: Send a prompt

  Scenario Outline: The reply streams into the transcript at <width>x<height>
    Given the viewport is <width>x<height>
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I capture "reply"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
