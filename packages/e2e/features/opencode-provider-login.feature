Feature: OpenCode provider login (GH-657)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN). The fake login plugin replaces the login of `groq`: no network, no real credential,
  # no model reply. Each scenario starts with no saved login.
  Scenario: Empty state, then the list loads on request
    Given the viewport is 1440x900
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    Then the OpenCode providers block offers "Show providers"
    And I capture "providers stopped"
    When I show the OpenCode providers
    Then the OpenCode providers say no provider is connected
    When I click "Connect a provider" in the OpenCode providers
    Then the provider search is focused
    And I capture "providers empty light"
    When I close Settings
    And I switch the theme mode to "dark"
    And I open Settings › OpenCode
    And I show the OpenCode providers
    Then I capture "providers empty dark"

  Scenario Outline: API key validation inline, then login at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I search the OpenCode providers for "groq"
    And I open the provider row "Groq"
    And I pick the login method "API key"
    And I type the API key "sk test" and leave the field
    Then the API key field shows the error "An API key has no spaces"
    And the page has no horizontal scroll
    And I capture "key error light"
    When I close Settings
    And I switch the theme mode to "dark"
    And I open Settings › OpenCode
    And I show the OpenCode providers
    And I search the OpenCode providers for "groq"
    And I open the provider row "Groq"
    And I pick the login method "API key"
    And I type the API key "sk test" and leave the field
    Then I capture "key error dark"
    When I type the API key "sk-throwaway-not-real" and connect
    Then the provider "Groq" is connected with the status "Connected · API key"
    And the OpenCode providers say "Connected to Groq"
    And the page has no horizontal scroll
    And I capture "key connected"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Log out asks first
    Given the viewport is 1440x900
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I connect Groq with the API key "sk-throwaway-not-real"
    And I click "Log out" on the provider "Groq"
    Then I capture "logout dialog"
    When I cancel the log out
    Then the provider "Groq" is connected with the status "Connected · API key"
    When I click "Log out" on the provider "Groq"
    And I confirm the log out
    Then the OpenCode providers say "Logged out of Groq"
    And the OpenCode providers say no provider is connected
    And the provider row "Groq" is in the connect list
    And I capture "logged out"

  Scenario Outline: Browser login waits and cancels, then finishes at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I search the OpenCode providers for "groq"
    And I open the provider row "Groq"
    And I pick the login method "Fake browser login"
    And I click Connect in the OpenCode form
    Then a login page tab opens
    And the OpenCode form shows the waiting view
    And the page has no horizontal scroll
    And I capture "waiting"
    When I cancel the OpenCode login
    Then the OpenCode providers say "Login cancelled"
    And I capture "cancelled"
    When I click Connect in the OpenCode form
    And I finish the login in the opened tab
    Then the provider "Groq" is connected with the status "Connected"
    And I capture "browser connected"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A wrong code is recoverable
    Given the viewport is 1440x900
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I search the OpenCode providers for "groq"
    And I open the provider row "Groq"
    And I pick the login method "Fake code login"
    And I click Connect in the OpenCode form
    And I send the login code "bad"
    Then the login code field shows an error
    And I capture "code error"
    When I send the login code "good"
    Then the provider "Groq" is connected with the status "Connected"
    And I capture "code connected"

  Scenario: The keyboard alone connects a provider
    Given the viewport is 1440x900
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I connect Groq with the keyboard using the API key "sk-throwaway-not-real"
    Then the provider "Groq" is connected with the status "Connected · API key"

  Scenario: A connected provider adds its models to a new OpenCode draft
    Given the viewport is 1440x900
    And OpenCode has the fake login plugin and no saved login
    And OpenCode is set up in a scratch project
    When I open Settings › OpenCode
    And I show the OpenCode providers
    And I connect Groq with the API key "sk-throwaway-not-real"
    And I close Settings
    And I choose the engine "OpenCode"
    Then the model picker lists the provider "Groq" when OpenCode has its models
    And I capture "model picker"
