Feature: Markdown preview shows tables at full height (GH-444)

  Scenario Outline: A long table in the Files preview is not capped, the preview pane scrolls at <width>x<height>
    Given the scratch project has the Markdown file "docs/table.md" with a table of 40 rows
    And the viewport is <width>x<height>
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "docs"
    And I open the tree file "docs/table.md"
    And I choose the Markdown view "Preview"
    Then the Markdown preview shows all 40 table rows with no inner table scroll box
    And the Markdown preview scrolls to the last table row
    And the page has no horizontal scroll
    And I capture "preview-full-table"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: The Split view shows the same full-height table in its preview half
    Given the scratch project has the Markdown file "docs/table.md" with a table of 40 rows
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "docs"
    And I open the tree file "docs/table.md"
    And I choose the Markdown view "Split"
    Then the Markdown preview is beside the source editor
    And the Markdown preview shows all 40 table rows with no inner table scroll box
    And the Markdown preview scrolls to the last table row
    And I capture "split-full-table"

  Scenario: A chat reply keeps the capped, scrolling table box
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with only a markdown table of the numbers 1 to 40: two columns, n and square, one row per number, header included, no other text."
    Then the turn has finished
    And the last chat reply has a table with an inner max-height box that scrolls
    And I capture "chat-table-capped"
