{operationName: "Generate", variables: {request: {model: "kling-3.0", public: true,…}},…}
operationName
: 
"Generate"
query
: 
"mutation Generate($request: CreateGenerationRequest!) {\n  generate(request: $request) {\n    apiCreditCost\n    generationId\n    __typename\n  }\n}"
variables
: 
{request: {model: "kling-3.0", public: true,…}}
request
: 
{model: "kling-3.0", public: true,…}
model
: 
"kling-3.0"
parameters
: 
{height: 1280, width: 720, duration: 6, mode: "RESOLUTION_720", motion_has_audio: false, quantity: 1,…}
duration
: 
6
guidances
: 
{start_frame: [{image: {id: "668d3074-ba78-4615-9793-b73b23b58bbb", type: "UPLOADED"}}]}
start_frame
: 
[{image: {id: "668d3074-ba78-4615-9793-b73b23b58bbb", type: "UPLOADED"}}]
height
: 
1280
mode
: 
"RESOLUTION_720"
motion_has_audio
: 
false
prompt
: 
"Create a 10-second premium tablet commercial based on the reference image. Use 12–15 different shots with fast-cut editing (0.5–0.8 seconds per shot). Every shot must be visually different.\n\nInclude a mix of:\n\nHero product shot\nCamera lens macro shot\nLight sweep across camera module\nMetallic edge reflections\nRotating tablet shot\nFloating product shot\nStylus writing\nStylus sketching\nTyping on screen\nMultitasking apps\nVideo streaming\nGaming scene\nClose-up screen details\nHand interaction\nPremium showroom display\nFinal hero shot with logo\n\nUse orbit shots, tracking shots, top-down shots, side angles, extreme close-ups, focus pulls, speed ramps, motion blur transitions, whip pans, and seamless match cuts. High-energy pacing, premium flagship launch style, luxury technology advertisement, ultra realistic, cinematic lighting, 4K HDR.\n\nEvery shot must be unique. Avoid repeating the same angle or scene. No static shots. No long shots over 1 second."
quantity
: 
1
width
: 
720
public
: 
true