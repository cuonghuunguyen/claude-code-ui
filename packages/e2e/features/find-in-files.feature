Feature: Find in files searches the content of the project's files (GH-649)

  Background:
    Given the scratch project has the search files
    And the scratch project is a git repository

  Scenario: Find in files on desktop: panel, plain search, ignored files, file filter, regular expression, Enter opens the match, selected text becomes the query
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
    And Include ignored files is off in Find in files
    When I click Include ignored files in Find in files
    Then Find in files lists the file "dist/out.js"
    And Include ignored files is on in Find in files
    When I click Include ignored files in Find in files
    Then Find in files lists only the files "src/a.ts,src/b.md"
    And I capture "find-ignored-toggle"
    When I limit Find in files to the files "*.md"
    Then Find in files lists only the files "src/b.md"
    And I capture "find-file-filter"
    When I limit Find in files to the files ""
    And I turn on regular expressions in Find in files
    And I search files for "foo\d"
    Then Find in files lists only the files "src/a.ts"
    And Find in files marks "foo1" on line 10 of "src/a.ts"
    And Find in files shows no alert
    And I capture "find-regex"
    When I press "Enter"
    Then the Find in files panel is closed
    And the Files editor shows the line "const needle = foo1;"
    And I capture "find-open-match"
    When I select "needle" on the Files editor line with "const needle = foo1;"
    And I press "ControlOrMeta+Shift+F"
    Then the Find in files query is "needle" and its file filter is ""
    And Find in files lists the file "src/a.ts"
    And I capture "find-prefill"
    When I press "Escape"
    And I select two lines of the Files editor
    And I press "ControlOrMeta+Shift+F"
    Then the Find in files query is "" and its file filter is ""
    And I capture "find-prefill-multiline"

  Scenario: The panel fits a phone screen
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I press "ControlOrMeta+Shift+F"
    And I search files for "needle"
    Then Find in files lists the file "src/a.ts"
    And the page has no horizontal scroll
    And I capture "find-plain-phone"
