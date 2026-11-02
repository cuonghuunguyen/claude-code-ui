Feature: The Files tree highlights the selected row (GH-525)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "lib/b.ts" with the text "export const b = 1;"

  Scenario Outline: A clicked folder row keeps its selected background in the <theme> theme
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I switch to the <theme> theme
    And I open the Files tab of the side panel
    And I click the tree row "src"
    And I move the pointer away from the tree
    Then the tree row "src" has the selected background
    And the tree row "lib" has no selected background
    And I capture "tree-selected-folder <theme>"
    When I click the tree row "lib"
    And I move the pointer away from the tree
    Then the tree row "lib" has the selected background
    And the tree row "src" has no selected background

    Examples:
      | theme |
      | light |
      | dark  |
