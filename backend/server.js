const express = require('express');
const app = express();
const cors = require('cors');
require('dotenv').config();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('API is running...');
});

app.listen(5001, () => console.log('Server running on port 5001'));
