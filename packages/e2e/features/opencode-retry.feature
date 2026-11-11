Feature: OpenCode shows its retry wait and a clear error when the model is not available (GH-683)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) but no login and no real model: the model is a local stub provider the scenario
  # declares in the run's isolated OpenCode config (<run>/ui-config/opencode/opencode.json) and answers 429, 503, 404 or OK on demand.
  Scenario: A rate-limited model shows the retry state with a countdown, and it clears when the provider answers
    Given the viewport is 1440x900
    And OpenCode has a model provider that answers 429 with a retry wait of 8 seconds
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see the retry state with the reason "Rate limit reached for m1"
    And the retry state counts down to a next try
    And the retry state is shown instead of Thinking
    And I capture "retry state 429"
    When the model provider answers OK
    Then I see a reply from Claude
    And the turn has finished
    And the retry state is gone
    And the transcript shows exactly 0 notices
    And I capture "retry cleared and reply shown"

  Scenario: An overloaded model (503) shows the retry state too
    Given the viewport is 1440x900
    And OpenCode has a model provider that answers 503 with a retry wait of 8 seconds
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see the retry state with the reason "Service Unavailable"
    And the retry state counts down to a next try
    And I capture "retry state 503"
    When the model provider answers OK
    Then I see a reply from Claude
    And the turn has finished
    And the retry state is gone

  # The old bug: the retry notice of a session had one id, so turn 2 updated the line inside turn 1 and showed only "Thinking".
  Scenario: In the second turn of a session the retry state shows at the bottom and turn 1 stays as it was
    Given the viewport is 1440x900
    And OpenCode has a model provider that answers 429 with a retry wait of 8 seconds
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: ONE"
    Then I see the retry state with the reason "Rate limit reached for m1"
    When the model provider answers OK
    Then I see a reply from Claude
    And the turn has finished
    And the retry state is gone
    And the transcript shows exactly 0 notices
    When the model provider answers 429 with a retry wait of 8 seconds
    And I send "Reply with exactly: TWO"
    Then the transcript shows 2 user messages
    And I see the retry state with the reason "Rate limit reached for m1"
    And the retry state counts down to a next try
    And the retry state is shown instead of Thinking
    And the retry state is below the last prompt of the transcript
    And the transcript has exactly 1 replies from Claude
    And the transcript shows exactly 0 notices
    And I capture "retry state in turn two"
    When the model provider answers OK
    Then I see at least 2 replies from Claude
    And the turn has finished
    And the retry state is gone
    And the transcript shows exactly 0 notices
    And I capture "turn two answered turn one unchanged"

  Scenario: Stop during the retry wait clears the retry state and leaves one Interrupted marker
    Given the viewport is 1440x900
    And OpenCode has a model provider that answers 429 with a retry wait of 30 seconds
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see the retry state with the reason "Rate limit reached for m1"
    And the retry state counts down to a next try
    When I stop the turn
    Then the turn has finished
    And the retry state is gone
    And the transcript shows exactly 1 interrupted markers
    And I capture "stopped during retry wait"

  Scenario: A model that does not exist ends the turn with one readable error
    Given the viewport is 1440x900
    And OpenCode is set to the model "stub/nope", which the provider does not offer
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And the page starts watching for a retry state
    And I send the first prompt "Reply with exactly: OK"
    Then I see the only notice containing "stub/nope"
    And the turn has finished
    And the only notice contains "Settings"
    And the only notice is readable and has no stack trace
    And the page never showed a retry state
    And I capture "unknown model error"

  Scenario: A provider that answers 404 model does not exist gives one readable error and no retry
    Given the viewport is 1440x900
    And OpenCode has a model provider that says the model does not exist
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And the page starts watching for a retry state
    And I send the first prompt "Reply with exactly: OK"
    Then I see the only notice containing "not available"
    And the turn has finished
    And the only notice contains "HTTP 404"
    And the only notice is readable and has no stack trace
    And the retry state is gone
    And the page never showed a retry state
    And I capture "provider 404 error"

  Scenario: The retry state is readable on a desktop and on a phone without sideways scroll
    Given the viewport is 1440x900
    And OpenCode has a model provider that answers 503 with a retry wait of 60 seconds and a very long explanation
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see the retry state with the reason "Service Unavailable"
    And the retry state counts down to a next try
    And the page has no horizontal scroll
    And I capture "retry state desktop"
    When the viewport becomes 390x844
    Then the retry state counts down to a next try
    And the page has no horizontal scroll
    And I capture "retry state phone"
