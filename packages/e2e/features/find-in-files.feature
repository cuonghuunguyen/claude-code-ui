Feature: Find in files searches the content of the project's files (GH-649)

  Background:
    Given the scratch project has the search files
    And the scratch project is a git repository

  Scenario: Find in files on desktop: panel, plain search, Enter opens the match
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    Then the Find in files panel is open
    And I capture "find-open"
    When I search files for "needle"
    Then Find in files lists only the files "src/a.ts,src/b.md"
    And Find in files marks the hits and shows the lines around line 10 of "src/a.ts"
    And Find in files does not list the file "dist/out.js"
    And Find in files does not list the file "bin.dat"
    And I capture "find-plain-desktop"
    When I press "Enter"
    Then the Find in files panel is closed
    And the Files editor shows the line "const needle = foo1;"
    And I capture "find-open-match"

  Scenario: The panel fits a phone screen
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    And I search files for "needle"
    Then Find in files lists the file "src/a.ts"
    And the page has no horizontal scroll
    And I capture "find-plain-phone"
