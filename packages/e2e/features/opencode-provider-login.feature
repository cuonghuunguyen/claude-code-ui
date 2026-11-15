Feature: OpenCode provider login (GH-657)

  Scenario Outline: API key login at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I search the OpenCode providers for "groq"
    And I open the provider row "Groq"
    And I pick the login method "API key"
    And I type the API key "sk-throwaway-not-real" and connect
    Then the provider "Groq" is connected with the status "Connected · API key"
    And the OpenCode providers say "Connected to Groq"
    And the page has no horizontal scroll
    And I capture "key connected"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
