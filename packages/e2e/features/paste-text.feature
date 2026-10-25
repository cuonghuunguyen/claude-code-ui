Feature: Pasted text blocks

  Scenario Outline: A large paste is a chip, then a collapsed block at <width>x<height>
    Given the viewport is <width>x<height>
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I paste 200 lines into the prompt box
    Then the prompt box shows 1 pasted-text chip
    And the prompt box is still small
    And I capture "chip"
    When I view the pasted text of the chip
    Then the pasted text viewer holds lines 1 to 200
    And I capture "viewer"
    When I close the pasted text viewer
    And I remove the pasted-text chip
    Then the prompt box shows 0 pasted-text chips
    When I paste 200 lines into the prompt box
    And I type " Reply with exactly: OK" after the paste
    And I send the prompt box
    Then the user message shows a collapsed pasted block of 199 lines
    And I capture "bubble-collapsed"
    When I expand the pasted block
    Then the pasted block holds lines 1 to 200
    And I capture "bubble-expanded"
    And I see a reply from Claude
    And the turn has finished
    And the session list shows no pasted_content text
    And the page has no horizontal scroll
    And I capture "after-reply"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A short paste stays plain text
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I paste "hello world" into the prompt box
    Then the prompt box shows 0 pasted-text chips
    And the browser inserts the short paste "hello world" into the prompt box
    And I capture "short"

  Scenario: The restored session shows the same collapsed block
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I paste 200 lines into the prompt box
    And I type " Reply with exactly: OK" after the paste
    And I send the prompt box
    Then I see a reply from Claude
    And the turn has finished
    When I restart the daemon
    Then the app is connected
    When I reload the page
    Then the user message shows a collapsed pasted block of 199 lines
    And the session list shows no pasted_content text
    When I expand the pasted block
    Then the pasted block holds lines 1 to 200
    And I capture "restored"
