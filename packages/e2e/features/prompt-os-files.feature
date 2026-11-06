Feature: Files pasted or dropped on the prompt box

  Scenario Outline: An OS file pasted in the prompt box becomes a mention at <width>x<height>
    Given the viewport is <width>x<height>
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I paste the OS file "notes.txt" in the prompt box
    Then the prompt box holds an @ mention of "notes.txt"
    And the prompt box text does not hold "content of"
    And no prompt error is shown
    And the page has no horizontal scroll
    And I capture "pasted"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario Outline: OS files dropped on the prompt box are attached at <width>x<height>
    Given the viewport is <width>x<height>
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I drop the OS files "one.txt, two.txt" on the prompt box
    Then the prompt box holds an @ mention of "one.txt"
    And the prompt box holds an @ mention of "two.txt"
    And no prompt error is shown
    And the page has no horizontal scroll
    And I capture "dropped"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A folder dropped with a file is skipped with an error
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I drop the OS file "kept.txt" and a folder on the prompt box
    Then the prompt box holds an @ mention of "kept.txt"
    And the prompt error says "Folders cannot be attached; mention them with @."
    And I capture "folder-skipped"

  # headless Chromium does not read the OS clipboard
  @headed
  Scenario: A file copied in the OS is pasted in the prompt box
    Given the scratch project has the file "moveme/inner.txt" with the text "inner"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    And the system clipboard holds the project file "moveme/inner.txt"
    When I press "ControlOrMeta+v" in the prompt box
    Then the prompt box holds an @ mention of "inner.txt"
    And I capture "os-file-pasted-prompt"
