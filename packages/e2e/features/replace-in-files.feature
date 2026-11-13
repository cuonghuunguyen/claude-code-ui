Feature: Replace in files rewrites the checked matches of Find in files (GH-650)

  Background:
    Given the scratch project has the replace files

  Scenario: Preview, exclude a match, Replace all, summary, results, Undo
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    And I turn on regular expressions in Find in files
    And I search files for "user\((\d)\)"
    And I show the replace row in Find in files
    And I type the replacement "account($1)" in Find in files
    Then Find in files previews 4 new lines
    And the preview of line 1 of "src/a.ts" reads "const x = account(1);"
    And I capture "replace-preview-desktop"
    When I uncheck the match on line 2 of "src/a.ts" in Find in files
    And I click Replace all in Find in files
    Then the Find in files summary says "Replaced 3 matches in 3 files."
    And the scratch file "src/a.ts" is "const x = account(1);\nconst y = user(2);\n"
    And the scratch file "src/b.ts" is "account(3)\r\nother\r\n"
    And the scratch file "notes.md" is "call account(4) here\n"
    And Find in files previews 1 new lines
    And I capture "replace-summary-desktop"
    When I click Undo in Find in files
    Then the Find in files summary says "Undid the replace in 3 files."
    And the scratch file "src/a.ts" is "const x = user(1);\nconst y = user(2);\n"
    And the scratch file "src/b.ts" is "user(3)\r\nother\r\n"
    And I capture "replace-undone-desktop"

  Scenario: A replacement that references a missing group shows an error and writes nothing
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    And I turn on regular expressions in Find in files
    And I search files for "user\((\d)\)"
    And I show the replace row in Find in files
    And I type the replacement "$3" in Find in files
    Then the Find in files replace error is shown
    And the scratch file "notes.md" is "call user(4) here\n"
    And I capture "replace-error-desktop"

  Scenario: The replace row fits a phone screen
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    And I search files for "user"
    And I show the replace row in Find in files
    And I type the replacement "account" in Find in files
    Then Find in files previews 4 new lines
    And the page has no horizontal scroll
    And I capture "replace-preview-phone"
