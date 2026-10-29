Feature: Aside (/btw)

  Scenario Outline: /btw opens an Aside that knows the owner's context at <width>x<height>
    Given the viewport is <width>x<height>
    And a Haiku session that has read "notes-465.txt"
    And I note the owner transcript
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then an aside popup shows
    And the aside shows a reply
    And the owner transcript is unchanged
    And the session list shows no aside
    And the page has no horizontal scroll
    And I capture "aside"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A follow-up continues the Aside
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then the aside shows a reply
    When I send "And what did it contain? One word." in the aside
    Then the aside shows at least 2 replies
    And the owner timeline shows 1 prompt
    And I capture "follow-up"

  Scenario: An Aside permission request shows in the popup and in Focus
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Use the Bash tool to run exactly this command and nothing else: echo e2e > aside-note.txt"
    Then the aside popup shows a permission request
    And the owner shows no permission request
    And I capture "aside-permission"
    When I open Focus
    Then Focus lists a request of an aside
    When I open the owner session
    And I allow the aside permission request
    Then the aside popup shows no permission request
    And I capture "aside-allowed"

  Scenario: An Aside cannot edit files
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Create the file aside-probe.txt with the content x using the Write tool only. If you cannot, reply with the word UNAVAILABLE and do nothing else."
    Then the aside shows a reply
    And the aside ran no Write or Edit tool
    And the file "aside-probe.txt" does not exist in the project
    And I capture "read-only"

  Scenario: The popup moves, resizes and minimizes while the owner stays usable
    Given the viewport is 1440x900
    And a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then an aside popup shows
    When I drag the aside popup by -200,100
    Then the aside popup has moved
    When I resize the aside popup by 120,80
    Then the aside popup has grown
    When I minimize the aside
    Then the aside shows as a chip
    When I send "Reply with exactly: hi" in the owner
    Then the owner turn has finished
    When I restore the aside
    Then an aside popup shows
    And I capture "moved"

  Scenario: The popup fills the screen on a phone
    Given the viewport is 390x844
    And a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then the aside popup fills the viewport
    And I capture "phone"

  Scenario: Close throws the Aside away
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then the aside shows a reply
    When I close the aside
    Then no aside popup shows
    And the aside transcript file does not exist
    And the session list shows no aside
    And I capture "closed"

  Scenario: /btw works while the owner's turn runs, and the owner's request is answerable with the popup open
    Given a Haiku session that has read "notes-465.txt"
    When I send "Use the Bash tool to run exactly this command: node -e 'setTimeout(()=>{},25000)'. After it finishes, use the Bash tool to run exactly this command: echo e2e > mid-turn.txt. Then say DONE." in the owner
    Then the owner shows a permission request
    When I allow the owner permission request
    Then the owner runs the "setTimeout" tool call
    When I ask the aside "What command are you waiting on? One line."
    Then the aside shows a reply
    And I capture "mid-turn"
    When the owner shows a permission request
    And I allow the owner permission request
    Then the owner turn has finished
    And the file "mid-turn.txt" exists in the project
    And the owner transcript does not mention "What command are you waiting on"

  Scenario: Keep as session turns the Aside into a session that survives a restart
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file was read? Reply with the file name."
    Then the aside shows a reply
    When I keep the aside as a session
    Then no aside popup shows
    And the kept session is open as a tab
    And the session list lists the aside
    And I capture "kept"
    When I restart the daemon
    Then the app is connected
    When I reload the page
    And I send "Reply with exactly: OK" in the owner
    Then the owner turn has finished
    And the permission mode is "Ask before edits"
    And I capture "kept-after-restart"

  Scenario: A leftover Aside is removed after a daemon restart
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then the aside shows a reply
    And I note the aside session
    When I restart the daemon
    Then the app is connected
    And the aside transcript file does not exist
    And the session list shows no aside
    And I capture "leftover"

  Scenario: Ask aside works behind the owner's permission card, from its button and from the command palette
    Given a Haiku session that has read "notes-465.txt"
    When I send "Use the Bash tool to run exactly this command and nothing else: echo e2e > card-note.txt" in the owner
    Then the owner shows a permission request
    When I ask the aside "Which file did we read? Answer with the file name only." above the permission card
    Then an aside popup shows
    And the aside shows a reply
    And the owner shows a permission request
    And I capture "card-button"
    When I run "Ask aside" from the command palette
    And I ask the aside "What is the first word of this session? One word." in the card question input
    Then 2 aside popups show
    And the owner shows a permission request
    And I capture "card-palette"
    When I allow the owner permission request
    Then the owner turn has finished
    And the file "card-note.txt" exists in the project

  Scenario: A second /btw opens a second popup
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    And I ask the aside "Reply with the word two."
    Then 2 aside popups show
    And the owner timeline shows 1 prompt
    And I capture "two-popups"

  Scenario: Popups hide with their owner tab and come back with it
    Given a Haiku session that has read "notes-465.txt"
    When I ask the aside "Which file did we read? Answer with the file name only."
    Then the aside shows a reply
    When I open the New session tab
    Then no aside popup shows
    And I capture "other-tab"
    When I open the first session tab
    Then an aside popup shows
    And the aside shows a reply
    And I capture "back"

  Scenario: /btw before the first Claude reply is refused
    Given the viewport is 1440x900
    And a new Haiku session
    When I send the first prompt "Use the Bash tool to run exactly this command and nothing else: echo x > refuse-note.txt. Write no text before the tool call."
    Then the owner shows a permission request
    When I ask the aside "Anything?" above the permission card
    Then the aside question input shows an error
    And no aside popup shows
    And I capture "refused"
